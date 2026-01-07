/**
 * Admin CLI Worker
 *
 * Local-only worker for querying environment data.
 * Uses service bindings to call DoRpcService methods directly (no HTTP routes).
 *
 * Usage:
 *   npm run admin:staging     # Query staging
 *   npm run admin:prod        # Query production
 *   npm run admin:dev-illiana # Query dev-illiana
 *   npm run admin:dev-miguel  # Query dev-miguel
 *
 * Then curl the endpoints:
 *   curl http://localhost:8787/overview
 *   curl http://localhost:8787/orgs
 *   curl http://localhost:8787/users
 */

import type { KVNamespace, R2Bucket, DispatchNamespace } from '@cloudflare/workers-types';
import type { DoRpcService } from '../../main/src/rpc-service';

// Cloudflare account and dispatch namespace info (same for all envs)
const CF_ACCOUNT_ID = '85bbd288051330fb51ee1c86031a299b';
const CF_DISPATCH_NAMESPACE = 'chiridion-platform';

interface Env {
	EMAIL_TO_USER: KVNamespace;
	R2: R2Bucket;
	DISPATCHER: DispatchNamespace;
	RPC: Service<DoRpcService>;
	TARGET_HOST: string;
	CF_API_TOKEN?: string; // Optional: for listing scripts via API
}

// Service binding with entrypoint gives us direct RPC access
type Service<T> = T;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		try {
			if (path === '/' || path === '/help') {
				return jsonResponse({
					name: 'Chiridion Admin CLI',
					description: 'Local worker for querying live data via RPC service bindings',
					targetHost: env.TARGET_HOST,
					usage: [
						'npm run admin:staging',
						'npm run admin:prod',
						'npm run admin:dev-illiana',
						'npm run admin:dev-miguel',
					],
					endpoints: {
						'/': 'This help message',
						'/overview': 'Admin overview (users, orgs, memberships)',
						'/orgs': 'List all organizations with members',
						'/users': 'List all users with org info',
						'/threads': 'List all threads across all orgs',
						'/kv-keys': 'List all KV keys (with optional ?prefix=)',
						'/r2/list': 'List R2 objects (with optional ?prefix=)',
						'/r2/info/{key}': 'Get R2 object metadata',
						'/r2/backup/{orgId}': 'Get backup info for an org',
						'/workers': 'List all user workers in dispatch namespace (with optional ?prefix=)',
						'/workers/{orgId}': 'List workers for a specific org',
						'/container/{orgId}/ls': 'List container workspace files (optional ?path=, ?recursive=)',
						'/container/{orgId}/read/{path}': 'Read a file from container workspace',
						'/container/{orgId}/write': 'Write a file to container (POST: {path, content})',
						'/container/{orgId}/mkdir': 'Create directory in container (POST: {path})',
						'/container/{orgId}/delete': 'Delete file/dir in container (POST: {path})',
						'/container/{orgId}/reset': 'Reset container (destroys and recreates)',
					},
				});
			}

			// RPC-based endpoints (call DoRpcService directly via entrypoint binding)
			if (path === '/overview') {
				const overview = await env.RPC.getAdminOverview();
				return jsonResponse({
					targetHost: env.TARGET_HOST,
					...overview,
				});
			}

			if (path === '/orgs') {
				const { items: orgs, total } = await env.RPC.adminGetOrgsPaginated({ limit: 1000 });
				// Enrich with member details
				const enrichedOrgs = await Promise.all(
					orgs.map(async (org) => {
						const members = await env.RPC.getOrgMembers(org.id);
						return {
							id: org.id,
							name: org.name,
							created_by: org.created_by,
							created_at: org.created_at,
							member_count: org.member_count,
							members: members.map((m) => ({
								user_id: m.user.id,
								email: m.user.email,
								name: m.user.name,
								role: m.role,
								joined_at: m.joined_at,
							})),
						};
					})
				);
				return jsonResponse({
					targetHost: env.TARGET_HOST,
					count: total,
					orgs: enrichedOrgs,
				});
			}

			if (path === '/users') {
				const { items: users, total } = await env.RPC.adminGetUsersPaginated({ limit: 1000 });
				return jsonResponse({
					targetHost: env.TARGET_HOST,
					count: total,
					users,
				});
			}

			if (path === '/threads') {
				const { items: threads, total } = await env.RPC.adminGetThreadsPaginated({ limit: 1000 });
				return jsonResponse({
					targetHost: env.TARGET_HOST,
					count: total,
					threads,
				});
			}

			// R2-based endpoints (direct R2 access)
			if (path === '/r2/list') {
				const prefix = url.searchParams.get('prefix') || undefined;
				return await listR2Objects(env, prefix);
			}

			if (path.startsWith('/r2/info/')) {
				const key = decodeURIComponent(path.slice(9));
				return await getR2ObjectInfo(env, key);
			}

			if (path.startsWith('/r2/backup/')) {
				const orgId = decodeURIComponent(path.slice(11));
				return await getOrgBackupInfo(env, orgId);
			}

			// KV-based endpoints (direct KV access)
			if (path === '/kv-keys') {
				const prefix = url.searchParams.get('prefix') || undefined;
				return await listKVKeys(env, prefix);
			}

			if (path.startsWith('/kv/')) {
				const key = decodeURIComponent(path.slice(4));
				return await getKVValue(env, key);
			}

			// Dispatch namespace endpoints (user workers)
			if (path === '/workers') {
				const prefix = url.searchParams.get('prefix') || undefined;
				return await listUserWorkers(env, prefix);
			}

			if (path.startsWith('/workers/')) {
				const orgId = decodeURIComponent(path.slice(9));
				// Org prefix is first 32 chars of orgId
				const prefix = orgId.slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '_');
				return await listUserWorkers(env, prefix, orgId);
			}

			// Container filesystem endpoints
			const containerMatch = path.match(/^\/container\/([^\/]+)\/(ls|read|write|mkdir|delete|reset)(\/.*)?$/);
			if (containerMatch) {
				const orgId = decodeURIComponent(containerMatch[1]!);
				const action = containerMatch[2]!;
				const pathArg = containerMatch[3] ? decodeURIComponent(containerMatch[3]) : undefined;

				return await handleContainerAction(env, request, url, orgId, action, pathArg);
			}

			return jsonResponse({ error: 'Not found', path }, 404);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			const stack = error instanceof Error ? error.stack : undefined;
			return jsonResponse({ error: message, stack }, 500);
		}
	},
};

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

// List all KV keys with optional prefix
async function listKVKeys(env: Env, prefix?: string): Promise<Response> {
	const keys: Array<{ name: string; metadata?: unknown }> = [];

	let cursor: string | undefined;
	while (true) {
		const list = await env.EMAIL_TO_USER.list({ prefix, cursor });
		for (const key of list.keys) {
			keys.push({ name: key.name, metadata: key.metadata });
		}
		if (list.list_complete) break;
		cursor = list.cursor;
	}

	return jsonResponse({
		targetHost: env.TARGET_HOST,
		prefix: prefix || '(all)',
		count: keys.length,
		keys,
	});
}

// Get a specific KV value
async function getKVValue(env: Env, key: string): Promise<Response> {
	const value = await env.EMAIL_TO_USER.get(key);
	if (value === null) {
		return jsonResponse({ error: 'Key not found', key }, 404);
	}

	// Try to parse as JSON
	try {
		const parsed = JSON.parse(value);
		return jsonResponse({ key, value: parsed, type: 'json' });
	} catch {
		return jsonResponse({ key, value, type: 'string' });
	}
}

// List R2 objects with optional prefix
async function listR2Objects(env: Env, prefix?: string): Promise<Response> {
	const objects: Array<{
		key: string;
		size: number;
		lastModified: string;
		etag: string;
	}> = [];

	let cursor: string | undefined;
	while (true) {
		const list = await env.R2.list({ prefix, cursor, limit: 1000 });
		for (const obj of list.objects) {
			objects.push({
				key: obj.key,
				size: obj.size,
				lastModified: obj.uploaded.toISOString(),
				etag: obj.etag,
			});
		}
		if (!list.truncated) break;
		cursor = list.cursor;
	}

	return jsonResponse({
		prefix: prefix || '(all)',
		count: objects.length,
		objects,
	});
}

// Get R2 object metadata
async function getR2ObjectInfo(env: Env, key: string): Promise<Response> {
	const obj = await env.R2.head(key);
	if (!obj) {
		return jsonResponse({ error: 'Object not found', key }, 404);
	}

	return jsonResponse({
		key: obj.key,
		size: obj.size,
		lastModified: obj.uploaded.toISOString(),
		etag: obj.etag,
		httpMetadata: obj.httpMetadata,
		customMetadata: obj.customMetadata,
	});
}

// Get backup info for a specific org
async function getOrgBackupInfo(env: Env, orgId: string): Promise<Response> {
	const backupKey = `${orgId}/workspace.tar.zst`;
	const obj = await env.R2.head(backupKey);

	if (!obj) {
		return jsonResponse({
			orgId,
			backupKey,
			exists: false,
			message: 'No backup found for this org',
		}, 404);
	}

	return jsonResponse({
		orgId,
		backupKey,
		exists: true,
		size: obj.size,
		sizeHuman: formatBytes(obj.size),
		lastModified: obj.uploaded.toISOString(),
		etag: obj.etag,
	});
}

function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 Bytes';
	const k = 1024;
	const sizes = ['Bytes', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper to derive org prefix from orgId (same as in main worker)
function deriveOrgPrefix(orgId: string): string {
	return orgId.slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// List all scripts in dispatch namespace via Cloudflare API
async function listDispatchScripts(apiToken: string): Promise<Array<{ id: string; created_on: string; modified_on: string }>> {
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/dispatch/namespaces/${CF_DISPATCH_NAMESPACE}/scripts`;
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${apiToken}` },
	});
	if (!response.ok) {
		throw new Error(`API request failed: ${response.status} ${response.statusText}`);
	}
	const data = (await response.json()) as { success: boolean; result?: Array<{ id: string; created_on: string; modified_on: string }>; errors?: unknown[] };
	if (!data.success) {
		throw new Error(`API error: ${JSON.stringify(data.errors)}`);
	}
	return data.result ?? [];
}

// List user workers in dispatch namespace
async function listUserWorkers(env: Env, prefix?: string, orgId?: string): Promise<Response> {
	// If we have an API token, use the Cloudflare API to list all scripts
	if (env.CF_API_TOKEN) {
		try {
			const allScripts = await listDispatchScripts(env.CF_API_TOKEN);

			// Get all orgs to map prefixes to org names
			const { items: orgs } = await env.RPC.adminGetOrgsPaginated({ limit: 1000 });
			const orgByPrefix = new Map(orgs.map((org) => [deriveOrgPrefix(org.id), org]));

			// Filter by orgId prefix if provided
			const orgPrefix = orgId ? deriveOrgPrefix(orgId) : prefix;
			const filteredScripts = orgPrefix
				? allScripts.filter((s) => s.id.startsWith(orgPrefix))
				: allScripts;

			// Enrich with org info
			const enrichedScripts = filteredScripts.map((script) => {
				// Find the org prefix (first 32 chars before the first dash after position 32)
				const possiblePrefix = script.id.slice(0, 32);
				const org = orgByPrefix.get(possiblePrefix);
				return {
					scriptName: script.id,
					orgPrefix: possiblePrefix,
					orgId: org?.id,
					orgName: org?.name,
					created_on: script.created_on,
					modified_on: script.modified_on,
				};
			});

			return jsonResponse({
				count: enrichedScripts.length,
				total: allScripts.length,
				filter: orgPrefix || '(all)',
				scripts: enrichedScripts,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return jsonResponse({ error: message, hint: 'Check CF_API_TOKEN is valid' }, 500);
		}
	}

	// Fallback: If an orgId is provided, try to get that specific worker via binding
	if (orgId) {
		const workerPrefix = deriveOrgPrefix(orgId);
		try {
			const worker = env.DISPATCHER.get(workerPrefix);
			const testRequest = new Request('https://test.example.com/health');
			const response = await worker.fetch(testRequest);
			const body = await response.text().catch(() => '(could not read body)');

			return jsonResponse({
				orgId,
				workerName: workerPrefix,
				exists: true,
				status: response.status,
				statusText: response.statusText,
				responsePreview: body.slice(0, 500),
				message: 'Worker found (but cannot list all workers without CF_API_TOKEN)',
				hint: 'Set CF_API_TOKEN in .dev.vars to list all workers for this org',
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return jsonResponse({
				orgId,
				workerName: workerPrefix,
				exists: false,
				error: message,
			}, 404);
		}
	}

	// Without API token and no specific orgId, we can't list workers
	return jsonResponse({
		error: 'Cannot list all workers without CF_API_TOKEN',
		hint: 'Add CF_API_TOKEN to workers/admin-cli/.dev.vars with a Cloudflare API token that has Workers Scripts Read permission',
	}, 400);
}

// Handle container filesystem actions
async function handleContainerAction(
	env: Env,
	request: Request,
	url: URL,
	orgId: string,
	action: string,
	pathArg?: string
): Promise<Response> {
	try {
		switch (action) {
			case 'ls': {
				const listPath = url.searchParams.get('path') || pathArg || '/';
				const recursive = url.searchParams.get('recursive') === 'true';
				const includeHidden = url.searchParams.get('includeHidden') !== 'false';

				const result = await env.RPC.listWorkspaceEntries(orgId, {
					path: listPath,
					recursive,
					includeHidden,
				});

				return jsonResponse({
					orgId,
					...result,
				});
			}

			case 'read': {
				if (!pathArg) {
					return jsonResponse({ error: 'Path required for read action' }, 400);
				}

				const result = await env.RPC.readWorkspaceFile(orgId, pathArg);
				if (!result) {
					return jsonResponse({ error: 'File not found', path: pathArg }, 404);
				}

				return jsonResponse({
					orgId,
					path: result.workspacePath,
					content: result.result.content,
					size: result.result.size,
					mimeType: result.result.mimeType,
					isBinary: result.result.isBinary,
					encoding: result.result.encoding,
				});
			}

			case 'write': {
				if (request.method !== 'POST') {
					return jsonResponse({ error: 'POST required for write action' }, 405);
				}

				const body = (await request.json()) as { path?: string; content?: string };
				const writePath = body.path || pathArg;
				if (!writePath) {
					return jsonResponse({ error: 'Path required for write action' }, 400);
				}
				if (body.content === undefined) {
					return jsonResponse({ error: 'Content required for write action' }, 400);
				}

				const result = await env.RPC.writeWorkspaceFile(orgId, writePath, body.content);
				return jsonResponse({
					orgId,
					path: result.workspacePath,
					success: result.result.success,
				});
			}

			case 'mkdir': {
				if (request.method !== 'POST') {
					return jsonResponse({ error: 'POST required for mkdir action' }, 405);
				}

				const body = (await request.json()) as { path?: string };
				const mkdirPath = body.path || pathArg;
				if (!mkdirPath) {
					return jsonResponse({ error: 'Path required for mkdir action' }, 400);
				}

				const result = await env.RPC.mkdirWorkspacePath(orgId, mkdirPath);
				return jsonResponse({
					orgId,
					path: result.workspacePath,
					success: result.result.success,
				});
			}

			case 'delete': {
				if (request.method !== 'POST') {
					return jsonResponse({ error: 'POST required for delete action' }, 405);
				}

				const body = (await request.json()) as { path?: string };
				const deletePath = body.path || pathArg;
				if (!deletePath) {
					return jsonResponse({ error: 'Path required for delete action' }, 400);
				}

				const result = await env.RPC.deleteWorkspacePath(orgId, deletePath);
				return jsonResponse({
					orgId,
					path: result.workspacePath,
					success: result.result.success,
				});
			}

			case 'reset': {
				if (request.method !== 'POST') {
					return jsonResponse({ error: 'POST required for reset action' }, 405);
				}

				const result = await env.RPC.resetOrgContainer(orgId);
				return jsonResponse({
					orgId,
					...result,
				});
			}

			default:
				return jsonResponse({ error: `Unknown container action: ${action}` }, 400);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return jsonResponse({ error: message, orgId, action }, 500);
	}
}
