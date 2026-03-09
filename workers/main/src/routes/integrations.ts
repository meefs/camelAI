/**
 * Integration OAuth routes
 * Supports: Slack, Notion
 */

import type { RouteContext } from '../types.js';
import { createIntegrationOAuthState, validateAndConsumeIntegrationOAuthState, type IntegrationOAuthState } from '../integration-oauth-state.js';
import { INTEGRATION_REGISTRY } from '../../../../src/lib/integration-registry.js';
import { decryptCredentials, encryptCredentials } from '../../../../src/lib/integration-crypto.js';
import { WorkspaceContainer } from '../workspace-container.js';
import { requireSession } from '../helpers/auth.js';
import type { ConnectionSetupResponse, ExternalTurnResult } from '../durable-objects.js';
import { runExternalMessageTurn } from '../helpers/external-turn.js';
import { getWorkspaceStub, getOrgStub } from '../helpers/stubs.js';
import { redirect, text } from '../helpers/response.js';
import { syncAllWorkspaceWorkerSecrets, type CfApiProxyEnv } from '../cf-api-proxy.js';
import type { SlackEventCallbackPayload } from '../slack-types.js';

// RPC interface for MCP DO callback
interface ChiridionMcpRpc {
  receiveConnectionSetupResponse(response: ConnectionSetupResponse): void;
}

interface SlackTeamInstallationRecord {
  workspace_id: string;
  org_id: string;
  integration_id: string;
  team_id: string;
  bot_user_id?: string;
  updated_at: number;
}

interface SlackCredentials {
  access_token?: string;
  bot_user_id?: string;
  team_id?: string;
}

type SlackExternalTurnResponse = ExternalTurnResult;

const SLACK_TEAM_INDEX_PREFIX = 'slack_team:';
const SLACK_THREAD_MAP_PREFIX = 'slack_thread:';
const SLACK_EVENT_DEDUPE_PREFIX = 'slack_event:';
const SLACK_MESSAGE_DEDUPE_PREFIX = 'slack_message:';
const SLACK_EVENT_DEDUPE_TTL_SECONDS = 10 * 60;
function getSlackTeamIndexKey(teamId: string): string {
  return `${SLACK_TEAM_INDEX_PREFIX}${teamId}`;
}

function getSlackThreadMapKey(workspaceId: string, teamId: string, channelId: string, rootTs: string): string {
  return `${SLACK_THREAD_MAP_PREFIX}${workspaceId}:${teamId}:${channelId}:${rootTs}`;
}

function getSlackMappingRootTs(
  event: NonNullable<SlackEventCallbackPayload['event']>,
  isDm: boolean
): string {
  const explicitThreadTs = (event.thread_ts || '').trim();
  if (explicitThreadTs) return explicitThreadTs;
  if (isDm) return 'dm';
  return (event.ts || '').trim();
}

function getSlackReplyThreadTs(event: NonNullable<SlackEventCallbackPayload['event']>): string {
  return (event.thread_ts || event.ts || '').trim();
}

function getSlackMessageDedupeKey(payload: SlackEventCallbackPayload): string | null {
  const event = payload.event;
  const teamId = payload.team_id?.trim();
  if (!event || !teamId) return null;
  if (event.type !== 'message' && event.type !== 'app_mention') return null;
  if (event.subtype) return null;

  const channelId = event.channel?.trim() || '';
  const userId = event.user?.trim() || '';
  const eventTs = (event.ts || '').trim();
  if (!channelId || !userId || !eventTs) return null;

  // Slack may emit both app_mention and message.* for a single @mention post.
  // Dedupe by message identity (not event_id) so we only process once.
  return `${SLACK_MESSAGE_DEDUPE_PREFIX}${teamId}:${channelId}:${userId}:${eventTs}`;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

async function verifySlackSignature(req: Request, rawBody: string, signingSecret: string): Promise<boolean> {
  const signature = req.headers.get('x-slack-signature') || '';
  const timestampHeader = req.headers.get('x-slack-request-timestamp') || '';
  const timestamp = Number(timestampHeader);

  if (!signature || !timestampHeader || !Number.isFinite(timestamp)) {
    return false;
  }

  const nowInSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowInSeconds - timestamp) > 60 * 5) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const base = `v0:${timestampHeader}:${rawBody}`;
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(base));
  const digest = `v0=${Array.from(new Uint8Array(signed)).map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  return timingSafeEqual(digest, signature);
}

function toSlackJsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function loadSlackTeamInstallations(kv: KVNamespace, teamId: string): Promise<SlackTeamInstallationRecord[]> {
  const raw = await kv.get(getSlackTeamIndexKey(teamId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as SlackTeamInstallationRecord[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((record) => (
      typeof record?.workspace_id === 'string' &&
      typeof record?.org_id === 'string' &&
      typeof record?.integration_id === 'string' &&
      typeof record?.team_id === 'string'
    ));
  } catch {
    return [];
  }
}

async function saveSlackTeamInstallations(
  kv: KVNamespace,
  teamId: string,
  records: SlackTeamInstallationRecord[]
): Promise<void> {
  await kv.put(getSlackTeamIndexKey(teamId), JSON.stringify(records));
}

async function upsertSlackTeamInstallation(
  kv: KVNamespace,
  record: SlackTeamInstallationRecord
): Promise<void> {
  const records = await loadSlackTeamInstallations(kv, record.team_id);
  const deduped = records.filter((candidate) => candidate.integration_id !== record.integration_id);
  deduped.unshift(record);
  await saveSlackTeamInstallations(kv, record.team_id, deduped.slice(0, 20));
}

function chooseSlackInstallationCandidates(
  records: SlackTeamInstallationRecord[],
  authorizations: Array<{ user_id?: string }> | undefined
): SlackTeamInstallationRecord[] {
  if (!authorizations || authorizations.length === 0) return records;
  const botUserIds = new Set(
    authorizations
      .map((entry) => entry.user_id)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  );
  if (botUserIds.size === 0) return records;

  const preferred = records.filter((record) => record.bot_user_id && botUserIds.has(record.bot_user_id));
  if (preferred.length > 0) return preferred;
  return records;
}

function normalizeSlackMessageText(rawText: string, botUserId?: string): string {
  let text = rawText.trim();
  if (botUserId) {
    const mention = new RegExp(`<@${botUserId}>`, 'g');
    text = text.replace(mention, '').trim();
  }
  return text;
}

async function postSlackThreadMessage(
  token: string,
  channel: string,
  threadTs: string,
  text: string
): Promise<void> {
  const safeText = text.trim().slice(0, 3500);
  if (!safeText) return;
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel,
      thread_ts: threadTs,
      text: safeText,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`chat.postMessage failed (${response.status}): ${body}`);
  }

  const payload = await response.json() as { ok?: boolean; error?: string };
  if (!payload.ok) {
    throw new Error(`chat.postMessage error: ${payload.error || 'unknown_error'}`);
  }
}

/**
 * Complete MCP connection setup request after OAuth flow succeeds.
 * Called when OAuth state contains MCP callback context.
 */
async function completeMcpConnectionSetup(
  env: RouteContext['env'],
  stateData: IntegrationOAuthState,
  integrationId: string,
  integrationType: string,
  integrationName: string
): Promise<void> {
  if (!stateData.mcp_request_id || !stateData.mcp_do_id) {
    return; // No MCP context
  }

  try {
    const mcpDoId = env.MCP_OBJECT.idFromString(stateData.mcp_do_id);
    const mcpStub = env.MCP_OBJECT.get(mcpDoId) as unknown as ChiridionMcpRpc;

    // Send success response to MCP - credentials are already stored via OAuth
    // We send empty credentials since they're already encrypted in the integration
    await mcpStub.receiveConnectionSetupResponse({
      requestId: stateData.mcp_request_id,
      cancelled: false,
      integration: {
        type: integrationType,
        name: integrationName,
        config: {},
        credentials: { _oauth_completed: true, integration_id: integrationId },
      },
    });
  } catch (err) {
    console.error('[Integration OAuth] Failed to complete MCP request:', err);
  }
}

/**
 * Sanitize redirect URL to prevent open redirect attacks.
 * Only allows relative paths starting with `/` (but not `//` which is protocol-relative).
 */
function sanitizeRedirectPath(input: string): string {
  // Default to /connections if empty
  if (!input) return '/connections';

  // Must start with exactly one `/` (not `//` which is protocol-relative)
  if (!input.startsWith('/') || input.startsWith('//')) {
    return '/connections';
  }

  // Strip any query params or fragments that might contain absolute URLs
  // and reconstruct with just the pathname
  try {
    const parsed = new URL(input, 'http://dummy');
    // Ensure the path doesn't encode an absolute URL
    if (parsed.pathname.includes('://') || parsed.pathname.startsWith('//')) {
      return '/connections';
    }
    return parsed.pathname + parsed.search;
  } catch {
    return '/connections';
  }
}

export async function handleSlackOAuthStart({ req, env, url }: RouteContext): Promise<Response> {
  const slackDef = INTEGRATION_REGISTRY.slack;
  if (!slackDef?.oauthConfig || !env.SLACK_CLIENT_ID) {
    return text('Slack OAuth is not configured', 500);
  }

  const auth = await requireSession(req, env);
  if ('error' in auth) return redirect(`${url.origin}/login?error=unauthorized`);

  const { session } = auth;
  if (!session.workspace_id) return redirect(`${url.origin}/connections?error=no_workspace`);

  const redirectTo = sanitizeRedirectPath(url.searchParams.get('redirect') || '/connections');
  const callbackUrl = `${url.origin}/api/integrations/slack/callback`;

  // Check for MCP callback context (from chat connection setup prompt)
  const mcpRequestId = url.searchParams.get('mcp_request_id');
  const mcpDoId = url.searchParams.get('mcp_do_id');
  const mcpContext = mcpRequestId && mcpDoId ? { requestId: mcpRequestId, doId: mcpDoId } : undefined;

  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    'slack',
    session.workspace_id,
    session.user_id,
    redirectTo,
    mcpContext
  );

  const authUrl = new URL(slackDef.oauthConfig.authorizationUrl);
  authUrl.searchParams.set('client_id', env.SLACK_CLIENT_ID);
  authUrl.searchParams.set('scope', slackDef.oauthConfig.scopes.join(','));
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('state', state);

  return redirect(authUrl.toString());
}

export async function handleSlackOAuthCallback({ env, url, ctx }: RouteContext): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return redirect(`${url.origin}/connections?error=oauth_denied`);
  if (!code || !state) return redirect(`${url.origin}/connections?error=oauth_invalid`);

  const stateData = await validateAndConsumeIntegrationOAuthState(env.SESSIONS, state);
  if (!stateData || stateData.integration_type !== 'slack') {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }

  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    return redirect(`${url.origin}/connections?error=oauth_config`);
  }

  try {
    const callbackUrl = `${url.origin}/api/integrations/slack/callback`;
    const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.SLACK_CLIENT_ID,
        client_secret: env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: callbackUrl,
      }),
    });

    const tokenData = (await tokenRes.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
      token_type?: string;
      scope?: string;
      bot_user_id?: string;
      app_id?: string;
      team?: { id: string; name: string };
      authed_user?: { id: string; access_token?: string };
    };

    if (!tokenData.ok || !tokenData.access_token) {
      return redirect(`${url.origin}/connections?error=oauth_token_failed`);
    }

    // Re-validate workspace access before creating integration
    // User may have been removed or workspace archived since OAuth started
    const wsStub = getWorkspaceStub(env, stateData.workspace_id);
    const wsInfo = await wsStub.getInfo();
    if (!wsInfo || wsInfo.archived) {
      return redirect(`${url.origin}/connections?error=workspace_not_found`);
    }

    const orgStub = getOrgStub(env, wsInfo.org_id);
    if (!(await orgStub.isMember(stateData.user_id))) {
      return redirect(`${url.origin}/connections?error=access_denied`);
    }

    const memberAccess = await wsStub.getMemberAccess(stateData.user_id);
    if ((memberAccess?.access_level ?? 'full') !== 'full') {
      return redirect(`${url.origin}/connections?error=access_denied`);
    }

    const credentials = {
      access_token: tokenData.access_token,
      token_type: tokenData.token_type,
      scope: tokenData.scope,
      bot_user_id: tokenData.bot_user_id,
      app_id: tokenData.app_id,
      team_id: tokenData.team?.id,
      team_name: tokenData.team?.name,
      user_access_token: tokenData.authed_user?.access_token,
      authed_user_id: tokenData.authed_user?.id,
    };

    const encrypted = await encryptCredentials(credentials, env.INTEGRATION_SECRET_KEY);
    const name = tokenData.team?.name || 'Slack';
    const integrationId = crypto.randomUUID();

    await wsStub.createIntegration(
      integrationId,
      'slack',
      name,
      'communication',
      'oauth2',
      JSON.stringify({}),
      encrypted,
      stateData.user_id
    );

    if (tokenData.team?.id) {
      await upsertSlackTeamInstallation(env.APP_KV, {
        workspace_id: stateData.workspace_id,
        org_id: wsInfo.org_id,
        integration_id: integrationId,
        team_id: tokenData.team.id,
        bot_user_id: tokenData.bot_user_id,
        updated_at: Date.now(),
      });
    }

    // Push secrets to running container
    ctx.waitUntil(
      new WorkspaceContainer(env, stateData.workspace_id, wsInfo.org_id)
        .refreshIntegrationEnvVars()
        .catch(() => {})
    );

    // Sync secrets to all deployed workers in this workspace
    ctx.waitUntil(
      syncAllWorkspaceWorkerSecrets(env as unknown as CfApiProxyEnv, stateData.workspace_id, wsInfo.org_id)
        .catch((err) => console.error('[slack-oauth] Failed to sync secrets to workers:', err))
    );

    // Complete MCP request if this OAuth flow was initiated from chat
    if (stateData.mcp_request_id && stateData.mcp_do_id) {
      await completeMcpConnectionSetup(env, stateData, integrationId, 'slack', name);
    }

    // Sanitize redirect URL again as defense-in-depth
    const safePath = sanitizeRedirectPath(stateData.redirect_url);
    const redirectUrl = new URL(safePath, url.origin);
    redirectUrl.searchParams.set('success', 'slack_connected');
    return redirect(redirectUrl.toString());
  } catch {
    return redirect(`${url.origin}/connections?error=oauth_failed`);
  }
}

async function resolveSlackInstallationForEvent(
  env: RouteContext['env'],
  payload: SlackEventCallbackPayload
): Promise<{
  workspaceId: string;
  orgId: string;
  teamId: string;
  botUserId?: string;
  token: string;
}> {
  const teamId = payload.team_id?.trim();
  if (!teamId) {
    throw new Error('Missing Slack team ID');
  }

  const stored = await loadSlackTeamInstallations(env.APP_KV, teamId);
  if (stored.length === 0) {
    throw new Error(`No Slack installation index found for team ${teamId}`);
  }

  const candidates = chooseSlackInstallationCandidates(stored, payload.authorizations);
  const staleIntegrationIds = new Set<string>();

  for (const candidate of candidates) {
    const wsStub = getWorkspaceStub(env, candidate.workspace_id);
    const [wsInfo, integration] = await Promise.all([
      wsStub.getInfo(),
      wsStub.getIntegration(candidate.integration_id),
    ]);

    if (!wsInfo || wsInfo.archived) {
      staleIntegrationIds.add(candidate.integration_id);
      continue;
    }
    if (!integration || integration.integration_type !== 'slack') {
      staleIntegrationIds.add(candidate.integration_id);
      continue;
    }

    let credentials: SlackCredentials;
    try {
      credentials = await decryptCredentials<SlackCredentials>(
        integration.credentials_encrypted,
        env.INTEGRATION_SECRET_KEY
      );
    } catch {
      continue;
    }

    if (credentials.team_id && credentials.team_id !== teamId) {
      continue;
    }

    const token = typeof credentials.access_token === 'string' ? credentials.access_token : '';
    if (!token) continue;

    const botUserId = typeof credentials.bot_user_id === 'string'
      ? credentials.bot_user_id
      : candidate.bot_user_id;

    return {
      workspaceId: candidate.workspace_id,
      orgId: candidate.org_id,
      teamId,
      botUserId,
      token,
    };
  }

  if (staleIntegrationIds.size > 0) {
    const filtered = stored.filter((record) => !staleIntegrationIds.has(record.integration_id));
    await saveSlackTeamInstallations(env.APP_KV, teamId, filtered);
  }

  throw new Error(`No active Slack installation found for team ${teamId}`);
}

async function getOrCreateSlackThreadId(
  env: RouteContext['env'],
  args: {
    workspaceId: string;
    orgId: string;
    teamId: string;
    channelId: string;
    rootTs: string;
    initialText: string;
  }
): Promise<string> {
  const mappingKey = getSlackThreadMapKey(
    args.workspaceId,
    args.teamId,
    args.channelId,
    args.rootTs
  );

  const existing = await env.APP_KV.get(mappingKey);
  if (existing) {
    return existing;
  }

  const orgStub = getOrgStub(env, args.orgId);
  const title = args.initialText.trim().slice(0, 100) || 'Slack conversation';
  const thread = await orgStub.createThread(
    args.workspaceId,
    title,
    'slack',
    args.initialText.trim().slice(0, 500) || undefined
  );

  await env.APP_KV.put(mappingKey, thread.id);
  return thread.id;
}

async function dispatchSlackTurnOutcome(
  token: string,
  channel: string,
  threadTs: string,
  result: SlackExternalTurnResponse
): Promise<void> {
  if (result.status === 'result') {
    const reply = result.reply?.trim();
    if (reply) {
      await postSlackThreadMessage(token, channel, threadTs, reply);
    }
    return;
  }

  if (result.status === 'busy') {
    await postSlackThreadMessage(
      token,
      channel,
      threadTs,
      'Claude is still processing the previous turn for this Slack thread. Please try again in a moment.'
    );
    return;
  }

  if (result.status === 'error') {
    await postSlackThreadMessage(
      token,
      channel,
      threadTs,
      result.error || 'I could not process that message right now.'
    );
  }
}

export async function processSlackEventCallback(
  env: RouteContext['env'],
  payload: SlackEventCallbackPayload
): Promise<void> {
  const event = payload.event;
  if (!event) return;
  if (event.type !== 'message' && event.type !== 'app_mention') return;
  if (event.subtype) return;

  const installation = await resolveSlackInstallationForEvent(env, payload);
  const channelId = event.channel?.trim() || '';
  const userId = event.user?.trim() || '';
  if (!channelId || !userId) return;
  if (event.bot_id) return;
  if (installation.botUserId && installation.botUserId === userId) return;

  const rawText = typeof event.text === 'string' ? event.text : '';
  const isDm = event.channel_type === 'im';
  const rootTs = getSlackMappingRootTs(event, isDm);
  if (!rootTs) return;

  const mappingKey = getSlackThreadMapKey(
    installation.workspaceId,
    installation.teamId,
    channelId,
    rootTs
  );
  const mappedThreadId = await env.APP_KV.get(mappingKey);
  const mentionsBot = installation.botUserId ? rawText.includes(`<@${installation.botUserId}>`) : false;
  const shouldHandle = isDm || event.type === 'app_mention' || mentionsBot || Boolean(mappedThreadId);
  if (!shouldHandle) return;

  const messageText = normalizeSlackMessageText(rawText, installation.botUserId);
  if (!messageText) return;

  const threadId = mappedThreadId || await getOrCreateSlackThreadId(env, {
    workspaceId: installation.workspaceId,
    orgId: installation.orgId,
    teamId: installation.teamId,
    channelId,
    rootTs,
    initialText: messageText,
  });

  const turnResult = await runExternalMessageTurn(env, {
    threadId,
    workspaceId: installation.workspaceId,
    orgId: installation.orgId,
    userName: `Slack ${userId}`,
    userEmail: null,
    message: messageText,
  });

  const replyThreadTs = getSlackReplyThreadTs(event);
  if (!replyThreadTs) return;

  await dispatchSlackTurnOutcome(installation.token, channelId, replyThreadTs, turnResult);
}

export async function handleSlackEvents({ req, env, ctx }: RouteContext): Promise<Response> {
  const signingSecret = env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return text('Slack signing secret is not configured', 500);
  }

  const rawBody = await req.text();
  const signatureValid = await verifySlackSignature(req, rawBody, signingSecret);
  if (!signatureValid) {
    return text('Invalid Slack signature', 401);
  }

  let payload: SlackEventCallbackPayload;
  try {
    payload = JSON.parse(rawBody) as SlackEventCallbackPayload;
  } catch {
    return text('Invalid JSON payload', 400);
  }

  if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
    return toSlackJsonResponse({ challenge: payload.challenge });
  }

  if (payload.type !== 'event_callback') {
    return text('ok', 200);
  }

  const eventId = payload.event_id?.trim();
  if (eventId) {
    const dedupeKey = `${SLACK_EVENT_DEDUPE_PREFIX}${eventId}`;
    const seen = await env.APP_KV.get(dedupeKey);
    if (seen) {
      return text('ok', 200);
    }
    await env.APP_KV.put(dedupeKey, '1', { expirationTtl: SLACK_EVENT_DEDUPE_TTL_SECONDS });
  }

  const messageDedupeKey = getSlackMessageDedupeKey(payload);
  if (messageDedupeKey) {
    const seenMessage = await env.APP_KV.get(messageDedupeKey);
    if (seenMessage) {
      return text('ok', 200);
    }
    await env.APP_KV.put(messageDedupeKey, '1', { expirationTtl: SLACK_EVENT_DEDUPE_TTL_SECONDS });
  }

  if (env.SLACK_EVENTS_QUEUE) {
    try {
      await env.SLACK_EVENTS_QUEUE.send({
        payload,
        received_at: Date.now(),
      });
    } catch (error) {
      console.error('[slack-events] failed to enqueue event callback', error);
      ctx.waitUntil(
        processSlackEventCallback(env, payload).catch((callbackError) => {
          console.error('[slack-events] failed to process callback fallback', callbackError);
        })
      );
    }
  } else {
    ctx.waitUntil(
      processSlackEventCallback(env, payload).catch((error) => {
        console.error('[slack-events] failed to process callback', error);
      })
    );
  }

  return text('ok', 200);
}

// =============================================================================
// Notion OAuth
// =============================================================================

export async function handleNotionOAuthStart({ req, env, url }: RouteContext): Promise<Response> {
  const notionDef = INTEGRATION_REGISTRY.notion;
  if (!notionDef?.oauthConfig || !env.NOTION_CLIENT_ID) {
    return text('Notion OAuth is not configured', 500);
  }

  const auth = await requireSession(req, env);
  if ('error' in auth) return redirect(`${url.origin}/login?error=unauthorized`);

  const { session } = auth;
  if (!session.workspace_id) return redirect(`${url.origin}/connections?error=no_workspace`);

  const redirectTo = sanitizeRedirectPath(url.searchParams.get('redirect') || '/connections');
  const callbackUrl = `${url.origin}/api/integrations/notion/callback`;

  // Check for MCP callback context (from chat connection setup prompt)
  const mcpRequestId = url.searchParams.get('mcp_request_id');
  const mcpDoId = url.searchParams.get('mcp_do_id');
  const mcpContext = mcpRequestId && mcpDoId ? { requestId: mcpRequestId, doId: mcpDoId } : undefined;

  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    'notion',
    session.workspace_id,
    session.user_id,
    redirectTo,
    mcpContext
  );

  const authUrl = new URL(notionDef.oauthConfig.authorizationUrl);
  authUrl.searchParams.set('client_id', env.NOTION_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('owner', 'user');
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('state', state);

  return redirect(authUrl.toString());
}

export async function handleNotionOAuthCallback({ env, url, ctx }: RouteContext): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return redirect(`${url.origin}/connections?error=oauth_denied`);
  if (!code || !state) return redirect(`${url.origin}/connections?error=oauth_invalid`);

  const stateData = await validateAndConsumeIntegrationOAuthState(env.SESSIONS, state);
  if (!stateData || stateData.integration_type !== 'notion') {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }

  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
    return redirect(`${url.origin}/connections?error=oauth_config`);
  }

  try {
    const callbackUrl = `${url.origin}/api/integrations/notion/callback`;

    // Notion uses Basic Auth for token exchange
    const basicAuth = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);
    const tokenRes = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
      }),
    });

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number; // Token lifetime in seconds
      refresh_token?: string; // For refreshing the access token
      bot_id?: string;
      workspace_id?: string;
      workspace_name?: string;
      workspace_icon?: string;
      owner?: {
        type: string;
        user?: {
          id: string;
          name?: string;
          avatar_url?: string;
          person?: { email?: string };
        };
      };
      duplicated_template_id?: string;
      request_id?: string;
      error?: string;
    };

    if (!tokenData.access_token) {
      console.error('[notion-oauth] Token exchange failed:', tokenData.error);
      return redirect(`${url.origin}/connections?error=oauth_token_failed`);
    }

    // Re-validate workspace access before creating integration
    const wsStub = getWorkspaceStub(env, stateData.workspace_id);
    const wsInfo = await wsStub.getInfo();
    if (!wsInfo || wsInfo.archived) {
      return redirect(`${url.origin}/connections?error=workspace_not_found`);
    }

    const orgStub = getOrgStub(env, wsInfo.org_id);
    if (!(await orgStub.isMember(stateData.user_id))) {
      return redirect(`${url.origin}/connections?error=access_denied`);
    }

    const memberAccess = await wsStub.getMemberAccess(stateData.user_id);
    if ((memberAccess?.access_level ?? 'full') !== 'full') {
      return redirect(`${url.origin}/connections?error=access_denied`);
    }

    // Calculate token expiry time (Notion tokens expire after ~1 hour)
    // Default to 1 hour if expires_in not provided
    const expiresInSeconds = tokenData.expires_in ?? 3600;
    const tokenExpiresAt = Date.now() + expiresInSeconds * 1000;

    const credentials = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token, // Stored but never pushed to containers
      expires_at: tokenExpiresAt,
      token_type: tokenData.token_type,
      bot_id: tokenData.bot_id,
      notion_workspace_id: tokenData.workspace_id,
      notion_workspace_name: tokenData.workspace_name,
      owner_user_id: tokenData.owner?.user?.id,
      owner_user_name: tokenData.owner?.user?.name,
      owner_user_email: tokenData.owner?.user?.person?.email,
    };

    const encrypted = await encryptCredentials(credentials, env.INTEGRATION_SECRET_KEY);
    const name = tokenData.workspace_name || 'Notion';
    const integrationId = crypto.randomUUID();

    await wsStub.createIntegration(
      integrationId,
      'notion',
      name,
      'saas',
      'oauth2',
      JSON.stringify({}),
      encrypted,
      stateData.user_id,
      tokenExpiresAt // Pass expiry for alarm scheduling
    );

    // Push secrets to running container
    ctx.waitUntil(
      new WorkspaceContainer(env, stateData.workspace_id, wsInfo.org_id)
        .refreshIntegrationEnvVars()
        .catch(() => {})
    );

    // Sync secrets to all deployed workers in this workspace
    ctx.waitUntil(
      syncAllWorkspaceWorkerSecrets(env as unknown as CfApiProxyEnv, stateData.workspace_id, wsInfo.org_id)
        .catch((err) => console.error('[notion-oauth] Failed to sync secrets to workers:', err))
    );

    // Complete MCP request if this OAuth flow was initiated from chat
    if (stateData.mcp_request_id && stateData.mcp_do_id) {
      await completeMcpConnectionSetup(env, stateData, integrationId, 'notion', name);
    }

    const safePath = sanitizeRedirectPath(stateData.redirect_url);
    const redirectUrl = new URL(safePath, url.origin);
    redirectUrl.searchParams.set('success', 'notion_connected');
    return redirect(redirectUrl.toString());
  } catch (err) {
    console.error('[notion-oauth] OAuth flow failed:', err);
    return redirect(`${url.origin}/connections?error=oauth_failed`);
  }
}

// =============================================================================
// Salesforce OAuth
// =============================================================================

export async function handleSalesforceOAuthStart({ req, env, url }: RouteContext): Promise<Response> {
  const salesforceDef = INTEGRATION_REGISTRY.salesforce;
  if (!salesforceDef?.oauthConfig || !env.SALESFORCE_CLIENT_ID) {
    return text('Salesforce OAuth is not configured', 500);
  }

  const auth = await requireSession(req, env);
  if ('error' in auth) return redirect(`${url.origin}/login?error=unauthorized`);

  const { session } = auth;
  if (!session.workspace_id) return redirect(`${url.origin}/connections?error=no_workspace`);

  const redirectTo = sanitizeRedirectPath(url.searchParams.get('redirect') || '/connections');
  const callbackUrl = `${url.origin}/api/integrations/salesforce/callback`;

  // Check for MCP callback context (from chat connection setup prompt)
  const mcpRequestId = url.searchParams.get('mcp_request_id');
  const mcpDoId = url.searchParams.get('mcp_do_id');
  const mcpContext = mcpRequestId && mcpDoId ? { requestId: mcpRequestId, doId: mcpDoId } : undefined;

  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    'salesforce',
    session.workspace_id,
    session.user_id,
    redirectTo,
    mcpContext
  );

  const authUrl = new URL(salesforceDef.oauthConfig.authorizationUrl);
  authUrl.searchParams.set('client_id', env.SALESFORCE_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', salesforceDef.oauthConfig.scopes.join(' '));
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('state', state);

  return redirect(authUrl.toString());
}

export async function handleSalesforceOAuthCallback({ env, url, ctx }: RouteContext): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return redirect(`${url.origin}/connections?error=oauth_denied`);
  if (!code || !state) return redirect(`${url.origin}/connections?error=oauth_invalid`);

  const stateData = await validateAndConsumeIntegrationOAuthState(env.SESSIONS, state);
  if (!stateData || stateData.integration_type !== 'salesforce') {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }

  if (!env.SALESFORCE_CLIENT_ID || !env.SALESFORCE_CLIENT_SECRET) {
    return redirect(`${url.origin}/connections?error=oauth_config`);
  }

  try {
    const callbackUrl = `${url.origin}/api/integrations/salesforce/callback`;

    // Salesforce uses form-encoded POST for token exchange
    const tokenRes = await fetch('https://login.salesforce.com/services/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.SALESFORCE_CLIENT_ID,
        client_secret: env.SALESFORCE_CLIENT_SECRET,
        code,
        redirect_uri: callbackUrl,
      }),
    });

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      instance_url?: string;
      id?: string;
      token_type?: string;
      issued_at?: string;
      signature?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenData.access_token) {
      console.error('[salesforce-oauth] Token exchange failed:', tokenData.error, tokenData.error_description);
      return redirect(`${url.origin}/connections?error=oauth_token_failed`);
    }

    // Re-validate workspace access before creating integration
    const wsStub = getWorkspaceStub(env, stateData.workspace_id);
    const wsInfo = await wsStub.getInfo();
    if (!wsInfo || wsInfo.archived) {
      return redirect(`${url.origin}/connections?error=workspace_not_found`);
    }

    const orgStub = getOrgStub(env, wsInfo.org_id);
    if (!(await orgStub.isMember(stateData.user_id))) {
      return redirect(`${url.origin}/connections?error=access_denied`);
    }

    const memberAccess = await wsStub.getMemberAccess(stateData.user_id);
    if ((memberAccess?.access_level ?? 'full') !== 'full') {
      return redirect(`${url.origin}/connections?error=access_denied`);
    }

    const credentials = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      instance_url: tokenData.instance_url,
      token_type: tokenData.token_type,
      user_id: tokenData.id, // Salesforce user ID URL
      scope: tokenData.scope,
    };

    const encrypted = await encryptCredentials(credentials, env.INTEGRATION_SECRET_KEY);

    // Extract org name from instance URL (e.g., https://myorg.salesforce.com -> myorg)
    const instanceHost = tokenData.instance_url ? new URL(tokenData.instance_url).hostname : '';
    const orgName = instanceHost.split('.')[0] || 'Salesforce';
    const name = orgName.charAt(0).toUpperCase() + orgName.slice(1);
    const integrationId = crypto.randomUUID();

    // Store instance_url in config for API calls
    const config = { instance_url: tokenData.instance_url };

    await wsStub.createIntegration(
      integrationId,
      'salesforce',
      name,
      'saas',
      'oauth2',
      JSON.stringify(config),
      encrypted,
      stateData.user_id
    );

    // Push secrets to running container
    ctx.waitUntil(
      new WorkspaceContainer(env, stateData.workspace_id, wsInfo.org_id)
        .refreshIntegrationEnvVars()
        .catch(() => {})
    );

    // Sync secrets to all deployed workers in this workspace
    ctx.waitUntil(
      syncAllWorkspaceWorkerSecrets(env as unknown as CfApiProxyEnv, stateData.workspace_id, wsInfo.org_id)
        .catch((err) => console.error('[salesforce-oauth] Failed to sync secrets to workers:', err))
    );

    // Complete MCP request if this OAuth flow was initiated from chat
    if (stateData.mcp_request_id && stateData.mcp_do_id) {
      await completeMcpConnectionSetup(env, stateData, integrationId, 'salesforce', name);
    }

    const safePath = sanitizeRedirectPath(stateData.redirect_url);
    const redirectUrl = new URL(safePath, url.origin);
    redirectUrl.searchParams.set('success', 'salesforce_connected');
    return redirect(redirectUrl.toString());
  } catch (err) {
    console.error('[salesforce-oauth] OAuth flow failed:', err);
    return redirect(`${url.origin}/connections?error=oauth_failed`);
  }
}
