#!/usr/bin/env node
/**
 * Migrate workspace data from JuiceFS (R2-backed) to Sprites.
 *
 * Runs locally — uses the `sprite` CLI to execute commands on remote sprites.
 *
 * Three phases (all syncs run in parallel on sprites):
 *   Phase 1 — Setup (sequential): Create sprites, install JuiceFS, upload
 *             metadata DB, launch background sync on each sprite.
 *   Phase 2 — Poll (round-robin): Check each sprite's sync status until all done.
 *             Includes stall detection — if size unchanged for 10 min, accept partial data.
 *   Phase 3 — Finalize (sequential): Rename dirs, add symlinks, cleanup, verify.
 *
 * Usage:
 *   node scripts/migrate-juicefs-to-sprites.mjs <env> [options]
 *
 *   env:             staging | prod
 *   --dry-run        Show what would happen without making changes
 *   --workspace=ID   Migrate only this workspace
 *   --skip-setup     Skip setup phase (resume polling already-running syncs)
 *   --verbose        Show detailed output
 *
 * Required environment variables:
 *   CF_API_TOKEN     Cloudflare API token with R2 temp credential access
 */

import { execFileSync } from 'node:child_process';
import { createHmac, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── Constants ───────────────────────────────────────────────────────────────

const CF_ACCOUNT_ID = '85bbd288051330fb51ee1c86031a299b';
const R2_BUCKET = 'chiridion-sandbox';
const R2_PARENT_ACCESS_KEY_ID = '4f8fdc386b4ccb9f4a2bea3c77c8ad95';
const R2_HOST = `${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const JUICEFS_VERSION = '1.2.2';
const CRED_TTL_SECONDS = 3600;
const CF_API_DELAY_MS = 2000; // Delay between CF API calls to avoid 429
const STALL_TIMEOUT_MS = 10 * 60_000; // 10 min — if sync size unchanged, accept partial data

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const ENV = args.find((a) => !a.startsWith('--')) || 'staging';
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const SKIP_SETUP = args.includes('--skip-setup');
const WORKSPACE_FILTER = args
  .find((a) => a.startsWith('--workspace='))
  ?.split('=')[1];

if (!['staging', 'prod'].includes(ENV)) {
  console.error(`Invalid env: ${ENV}. Use 'staging' or 'prod'.`);
  process.exit(1);
}

// Get CF API token from env or wrangler config
function getCfApiToken() {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN;
  const configPath = join(homedir(), 'Library/Preferences/.wrangler/config/default.toml');
  if (existsSync(configPath)) {
    const content = readFileSync(configPath, 'utf-8');
    const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }
  return null;
}

const CF_API_TOKEN = getCfApiToken();
if (!CF_API_TOKEN && !DRY_RUN) {
  console.error('CF_API_TOKEN not found. Set it or run "npx wrangler login".');
  process.exit(1);
}

// ─── Retry helper ───────────────────────────────────────────────────────────

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function withRetry(fn, { retries = 3, baseDelay = 2000, label = 'op' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === retries) throw e;
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      const errMsg = e.message?.slice(0, 80) || String(e);
      console.log(`  [retry] ${label} attempt ${attempt + 1}/${retries + 1} failed: ${errMsg}. Retrying in ${(delay / 1000).toFixed(1)}s...`);
      sleep(Math.round(delay));
    }
  }
}

// ─── Workspace Inventory ─────────────────────────────────────────────────────
// Hardcoded from docs/juicefs-to-sprites-migration.md.

const PROD_WORKSPACES = [
  { orgId: '61371e27-8d1f-4f2a-bfca-f5c90c4482b2', workspaceId: 'f31f3c35-4ed5-4981-a312-5d614a341432', metadata: 'juicefs-metadata.db', owner: 'Isabella (Default)' },
  { orgId: 'b3c2abf0-04ff-4140-8b81-ec3519ae428f', workspaceId: '7717de73-19e7-4af2-88bc-d36ea4f8d4d8', metadata: 'juicefs-metadata.db', owner: 'm (1033072+Vercantez@users.noreply.github.com)' },
  { orgId: '4b908619-a40c-43c4-8ddd-5235b0e926eb', workspaceId: '211350ca-938c-4a59-a02a-cde1bb25448b', metadata: 'juicefs-meta.db', owner: 'Ryan Wallace' },
  { orgId: 'eb050f6f-6e7f-46da-ab43-dede40728eec', workspaceId: '99d6b00c-66ab-4dd7-844f-0bfd49dc16b3', metadata: 'juicefs-meta.db', owner: 'm (developer@example.com)' },
  { orgId: '9bf451e2-ba63-44b9-8a46-5a2793d6dccc', workspaceId: 'ead86ea1-d903-47b3-8bc2-106148e36030', metadata: 'juicefs-metadata.db', owner: 'Illiana' },
  { orgId: '17c26e5a-cc45-4665-a0bd-1992023771cc', workspaceId: '791ba1b7-6d8b-44e6-9a24-1e20d559ee6d', metadata: 'juicefs-meta.db', owner: 'Dori Wilson (Default)' },
  { orgId: '17c26e5a-cc45-4665-a0bd-1992023771cc', workspaceId: '364ce7fc-9557-41ee-9eb6-556fc4c5f1c7', metadata: 'juicefs-metadata.db', owner: 'Dori Wilson (LLM Editors)' },
  { orgId: '17c26e5a-cc45-4665-a0bd-1992023771cc', workspaceId: '794b0f22-0d0c-46f9-a611-67c75f4c8b5c', metadata: 'juicefs-meta.db', owner: 'Dori Wilson (LLM Editors v0.1)' },
  { orgId: '4d3d17fe-6aeb-4dab-aa15-b4c138985763', workspaceId: 'f6c2b2c8-0d89-425e-aa82-7e1ec275ece2', metadata: 'juicefs-metadata.db', owner: 'Jim Foster' },
  { orgId: 'de6fe8c6-531c-4a71-b41a-83282802b4a6', workspaceId: '61c82c55-ccec-4272-8ebc-42be4aa87fde', metadata: 'juicefs-metadata.db', owner: 'Joseph Reed' },
  { orgId: '536fe3b5-ba07-4e49-8c12-a7fc6ba1cda7', workspaceId: '9cb5a6c8-9296-45d2-bd20-df831bffe04b', metadata: 'juicefs-metadata.db', owner: 'Jonah Reed' },
  { orgId: '61371e27-8d1f-4f2a-bfca-f5c90c4482b2', workspaceId: '83dd066b-703e-4e23-a116-ae39f41560b4', metadata: 'juicefs-metadata.db', owner: 'Isabella (Testing Grounds)' },
  { orgId: 'd9eeb1b9-e5a1-4f54-bf9b-2a98360e3627', workspaceId: 'd8bd48e3-8f1c-46af-a3d3-30b2d2f0f095', metadata: 'juicefs-metadata.db', owner: 'camelAI Team' },
  { orgId: '80045c71-5eb3-49aa-8d3a-af0a0d8fe0f5', workspaceId: '989dafd7-bae7-4554-bfbf-2aab4c662a9f', metadata: 'juicefs-metadata.db', owner: 'Daiki Rokuyama' },
  { orgId: 'bc900b21-b493-48a5-8a1d-f354d334ed17', workspaceId: '5cb40700-2a90-4bc1-aba9-7e9a5631b022', metadata: 'juicefs-metadata.db', owner: 'Jojo' },
  { orgId: '898799c3-5253-4a21-93ed-1561e98b895d', workspaceId: 'e0c102a1-b07c-41a2-bfc2-c71b676177a8', metadata: 'juicefs-metadata.db', owner: 'Y Y' },
  { orgId: 'ba5d7fe6-a0d2-47c3-bf6a-53b3e62c16b0', workspaceId: 'acec1c5b-f914-48d3-a26c-829465d7264f', metadata: 'juicefs-metadata.db', owner: 'Kizawa' },
  { orgId: '7efde494-a716-476c-8d1a-bb9d45a61011', workspaceId: '68543dc8-78ef-4b6e-b263-a0ed2811a5ef', metadata: 'juicefs-metadata.db', owner: 'Yojiro Kondo' },
];

const STAGING_WORKSPACES = [
  { orgId: 'd05d9084-bb7d-4960-a72a-fb67bdf77599', workspaceId: 'bce87a9c-129b-4748-96a1-e7f569b153fc', metadata: 'juicefs-metadata.db', owner: 'm - Default' },
  { orgId: 'd05d9084-bb7d-4960-a72a-fb67bdf77599', workspaceId: '27d53501-53e4-4dbe-a66a-e4b7886a283a', metadata: 'juicefs-metadata.db', owner: 'm - test' },
];

// ─── Name Computation ────────────────────────────────────────────────────────
// Mirrors workspace-container.ts

function computeSpriteName(workspaceId) {
  const safeId = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const containerId = `ws-${safeId}`.slice(0, 63);
  const raw = `chiridion-${containerId}`;
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
}

// ─── R2 Credentials + S3v4 Download ──────────────────────────────────────────

let lastCfApiCall = 0;

async function getScopedR2Creds(prefixes) {
  return withRetry(async () => {
    // Rate limit: wait at least CF_API_DELAY_MS between calls
    const elapsed = Date.now() - lastCfApiCall;
    if (elapsed < CF_API_DELAY_MS) {
      sleep(CF_API_DELAY_MS - elapsed);
    }
    lastCfApiCall = Date.now();

    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/temp-access-credentials`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucket: R2_BUCKET,
          parentAccessKeyId: R2_PARENT_ACCESS_KEY_ID,
          permission: 'object-read-only',
          ttlSeconds: CRED_TTL_SECONDS,
          prefixes,
        }),
      }
    );
    const text = await res.text();
    if (res.status === 429) {
      throw new Error(`Rate limited (429). Retrying...`);
    }
    if (res.status === 401) {
      throw new Error(`Auth failed (401). Wrangler token may be expired. Run: npx wrangler login`);
    }
    if (!res.ok) throw new Error(`R2 creds failed: ${res.status} ${text}`);
    const data = JSON.parse(text);
    if (!data.success) throw new Error(`CF API error: ${data.errors.map((e) => e.message).join(', ')}`);
    return data.result;
  }, { retries: 4, baseDelay: 3000, label: `R2 creds [${prefixes[0]?.slice(0, 30)}]` });
}

/** Download a file from R2 using S3v4 auth headers. Returns a Buffer. */
async function downloadFromR2(creds, key) {
  return withRetry(async () => {
    const region = 'auto', service = 's3';
    const now = new Date();
    const ds = now.toISOString().slice(0, 10).replace(/-/g, '');
    const amzDate = `${ds}T${now.toISOString().slice(11, 19).replace(/:/g, '')}Z`;
    const canonicalUri = `/${R2_BUCKET}/${key}`;

    const headerEntries = [
      ['accept-encoding', 'identity'],
      ['host', R2_HOST],
      ['x-amz-content-sha256', 'UNSIGNED-PAYLOAD'],
      ['x-amz-date', amzDate],
    ];
    if (creds.sessionToken) headerEntries.push(['x-amz-security-token', creds.sessionToken]);
    headerEntries.sort((a, b) => a[0].localeCompare(b[0]));

    const canonicalHeaders = headerEntries.map(([k, v]) => `${k}:${v}`).join('\n') + '\n';
    const signedHeaders = headerEntries.map(([k]) => k).join(';');

    const canonicalRequest = ['GET', canonicalUri, '', canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
    const scope = `${ds}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

    let sigKey = createHmac('sha256', `AWS4${creds.secretAccessKey}`).update(ds).digest();
    sigKey = createHmac('sha256', sigKey).update(region).digest();
    sigKey = createHmac('sha256', sigKey).update(service).digest();
    sigKey = createHmac('sha256', sigKey).update('aws4_request').digest();
    const signature = createHmac('sha256', sigKey).update(stringToSign).digest('hex');

    const headers = Object.fromEntries(headerEntries);
    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(`https://${R2_HOST}${canonicalUri}`, { headers });
    if (!res.ok) throw new Error(`R2 download failed: ${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  }, { retries: 3, baseDelay: 2000, label: `R2 download [${key.slice(-30)}]` });
}

// ─── Sprite Execution (sequential — sprite CLI has config race conditions) ───

function spriteExec(spriteName, script, { envVars = {}, timeout = 300_000 } = {}) {
  const exports = Object.entries(envVars)
    .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
    .join('; ');
  const fullScript = exports ? `${exports}; ${script}` : script;

  if (VERBOSE) {
    const safe = fullScript.replace(/export \S+='[^']*'/g, (m) => m.slice(0, m.indexOf('=')) + "='***'");
    console.log(`  [exec] ${safe.slice(0, 200)}${safe.length > 200 ? '...' : ''}`);
  }

  return execFileSync(
    'sprite', ['exec', '-s', spriteName, '--', 'bash', '-c', fullScript],
    { encoding: 'utf-8', timeout, maxBuffer: 10 * 1024 * 1024 }
  ).trim();
}

function spriteExecRetry(spriteName, script, opts = {}) {
  const { retries = 2, ...execOpts } = opts;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return spriteExec(spriteName, script, execOpts);
    } catch (e) {
      const isTransient = /ETIMEDOUT|i\/o timeout|ECONNRESET|ECONNREFUSED|failed to connect/.test(e.message || e.stderr || '');
      if (!isTransient || attempt === retries) throw e;
      const delay = 5000 * Math.pow(2, attempt);
      console.log(`  [retry] sprite exec attempt ${attempt + 1}/${retries + 1} failed (transient). Retrying in ${delay / 1000}s...`);
      sleep(delay);
    }
  }
}

function spriteCreate(spriteName) {
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      execFileSync('sprite', ['create', spriteName], { encoding: 'utf-8', timeout: 60_000 });
      return;
    } catch (e) {
      if (e.stderr?.includes('already exists') || e.stdout?.includes('already exists')) return;
      // Check if sprite is reachable even if create failed
      try { spriteExec(spriteName, 'true', { timeout: 30_000 }); return; } catch {}
      const isTransient = /ETIMEDOUT|i\/o timeout|ECONNRESET|failed to connect/.test(e.message || e.stderr || '');
      if (!isTransient || attempt === 2) {
        throw new Error(`Failed to create or reach sprite: ${e.stderr || e.message}`);
      }
      const delay = 5000 * Math.pow(2, attempt);
      console.log(`  [retry] sprite create attempt ${attempt + 1}/3 failed (transient). Retrying in ${delay / 1000}s...`);
      sleep(delay);
    }
  }
}

function ensureJuiceFs(spriteName) {
  try {
    const out = spriteExecRetry(spriteName, 'juicefs version 2>/dev/null && echo OK || echo MISSING', { timeout: 30_000 });
    if (out.includes('OK')) return;
  } catch { /* missing */ }

  const url = `https://github.com/juicedata/juicefs/releases/download/v${JUICEFS_VERSION}/juicefs-${JUICEFS_VERSION}-linux-amd64.tar.gz`;
  spriteExecRetry(spriteName, `curl -sSL '${url}' | sudo tar -xz -C /usr/local/bin juicefs && juicefs version`);
}

// ─── Phase 1: Setup (sequential) ────────────────────────────────────────────
// Create sprites, install JuiceFS, upload metadata, launch background syncs.
// Each workspace takes ~30s. Sequential to avoid sprite CLI config corruption.

async function setupWorkspace(ws) {
  const { orgId, workspaceId, metadata, owner } = ws;
  const spriteName = computeSpriteName(workspaceId);
  const metadataKey = `${orgId}/${workspaceId}/${metadata}`;
  const tag = owner.padEnd(30).slice(0, 30);
  const log = (...a) => console.log(`  [${tag}]`, ...a);

  log(`sprite=${spriteName}`);

  // 1. Create sprite + install JuiceFS
  log('Ensuring sprite exists...');
  spriteCreate(spriteName);
  ensureJuiceFs(spriteName);

  // 2. Download metadata DB from R2
  log(`Downloading ${metadata} from R2...`);
  const metaCreds = await getScopedR2Creds([`${orgId}/${workspaceId}/`]);
  const metadataBuf = await downloadFromR2(metaCreds, metadataKey);
  log(`Downloaded ${(metadataBuf.length / 1024 / 1024).toFixed(1)} MB. Uploading to sprite...`);
  spriteExecRetry(spriteName, 'mkdir -p /tmp/jfs', { timeout: 30_000 });
  execFileSync(
    'sprite', ['exec', '-s', spriteName, '--', 'bash', '-c', `cat > '/tmp/jfs/${metadata}'`],
    { input: metadataBuf, timeout: 120_000, maxBuffer: 50 * 1024 * 1024 }
  );

  // 3. Read actual volume name from metadata DB
  const volumeName = spriteExecRetry(
    spriteName,
    `sqlite3 '/tmp/jfs/${metadata}' "SELECT json_extract(CAST(value AS TEXT), '$.Name') FROM jfs_setting WHERE CAST(name AS TEXT)='format';"`,
    { timeout: 30_000 }
  );
  log(`volume=${volumeName}`);

  // 4. Update creds in metadata DB
  log('Generating block creds + updating metadata...');
  const blockCreds = await getScopedR2Creds([`${volumeName}/`]);
  const juicefsEnv = {
    ACCESS_KEY: blockCreds.accessKeyId,
    SECRET_KEY: blockCreds.secretAccessKey,
    SESSION_TOKEN: blockCreds.sessionToken,
  };
  spriteExecRetry(
    spriteName,
    `juicefs config "sqlite3:///tmp/jfs/${metadata}" --access-key "$ACCESS_KEY" --secret-key "$SECRET_KEY" --session-token "$SESSION_TOKEN" --yes --force`,
    { envVars: juicefsEnv, timeout: 30_000 }
  );

  // 5. Launch background sync
  // Use --log flag so juicefs writes to its own log file, and capture sync output separately
  log('Launching background sync...');
  const excludes = [
    '--exclude', '.chiridion/',
    '--exclude', '.claude/skills/',
    '--exclude', 'node_modules/',
    '--exclude', '.cache/',
    '--exclude', '.yarn-cache/',
    '--exclude', '.npm/',
    '--exclude', '.snapshots/',
  ].join(' ');

  const syncLog = '/tmp/jfs/sync.log';
  const syncDone = '/tmp/jfs/sync.done';
  // Fix: only use inner redirect, no outer redirect conflict
  spriteExecRetry(
    spriteName,
    `rm -f ${syncDone} ${syncLog}; nohup bash -c 'juicefs sync "jfs://myvol/" /home/sprite/ ${excludes} --log ${syncLog} --no-usage-report 2>&1; echo \\$? > ${syncDone}' </dev/null >/dev/null 2>&1 &`,
    { envVars: { myvol: `sqlite3:///tmp/jfs/${metadata}` }, timeout: 15_000 }
  );

  log('Sync launched.');
  return { ...ws, spriteName, syncStartedAt: Date.now(), volumeName };
}

// ─── Phase 2: Poll (round-robin) ────────────────────────────────────────────
// Check each running sync sequentially in a loop until all complete.
// All syncs run concurrently on their sprites — we just check one at a time.
// Stall detection: if sync size unchanged for STALL_TIMEOUT_MS, kill and accept.

function pollSyncs(running) {
  const syncLog = '/tmp/jfs/sync.log';
  const syncDone = '/tmp/jfs/sync.done';
  const maxWait = 3600_000; // 1 hour per workspace
  const completed = [];
  const failed = [];

  // Track size history for stall detection
  const sizeHistory = new Map(); // spriteName → { size, changedAt }

  while (running.length > 0) {
    const toRemove = [];

    for (let i = 0; i < running.length; i++) {
      const ws = running[i];
      const elapsed = ((Date.now() - ws.syncStartedAt) / 1000).toFixed(0);
      const tag = ws.owner.padEnd(30).slice(0, 30);

      if (Date.now() - ws.syncStartedAt > maxWait) {
        console.log(`  [${tag}] TIMEOUT after ${elapsed}s — accepting partial data`);
        // Kill sync and accept what we have
        try { spriteExec(ws.spriteName, 'pkill -f "juicefs sync" 2>/dev/null || true', { timeout: 10_000 }); } catch {}
        completed.push(ws);
        toRemove.push(i);
        continue;
      }

      try {
        const done = spriteExec(ws.spriteName, `cat ${syncDone} 2>/dev/null || echo RUNNING`, { timeout: 15_000 });
        if (done !== 'RUNNING') {
          const syncOutput = spriteExec(ws.spriteName, `tail -20 ${syncLog} 2>/dev/null || echo "(no log)"`, { timeout: 15_000 });
          const found = syncOutput.split('\n').filter(l => l.includes('Found:')).pop();
          console.log(`  [${tag}] Finished: ${found || syncOutput.split('\n').pop()} (${elapsed}s)`);
          if (done.trim() !== '0') {
            console.log(`  [${tag}] Warning: exit code ${done.trim()} (some files may have failed)`);
          }
          completed.push(ws);
          toRemove.push(i);
          continue;
        }

        // Show progress + stall detection
        const size = spriteExec(ws.spriteName, `du -sh /home/sprite/ 2>/dev/null | cut -f1`, { timeout: 15_000 });
        console.log(`  [${tag}] Syncing... ${size} (${elapsed}s)`);

        // Track size for stall detection
        const prev = sizeHistory.get(ws.spriteName);
        if (!prev || prev.size !== size) {
          sizeHistory.set(ws.spriteName, { size, changedAt: Date.now() });
        } else if (Date.now() - prev.changedAt > STALL_TIMEOUT_MS) {
          console.log(`  [${tag}] STALLED at ${size} for ${((Date.now() - prev.changedAt) / 60_000).toFixed(0)}min — killing sync, accepting partial data`);
          try { spriteExec(ws.spriteName, 'pkill -9 -f "juicefs sync" 2>/dev/null; sleep 1; true', { timeout: 15_000 }); } catch {}
          completed.push(ws);
          toRemove.push(i);
          continue;
        }
      } catch (e) {
        if (VERBOSE) console.log(`  [${tag}] poll error: ${e.message?.slice(0, 100)}`);
      }
    }

    // Remove completed/failed (iterate backwards to preserve indices)
    for (const idx of toRemove.sort((a, b) => b - a)) {
      running.splice(idx, 1);
    }

    if (running.length > 0) {
      // Sleep before next round — shorter if few workspaces, longer if many
      const sleepMs = Math.max(10_000, Math.min(30_000, running.length * 3_000));
      sleep(sleepMs);
    }
  }

  return { completed, failed };
}

// ─── Phase 3: Finalize (sequential) ─────────────────────────────────────────

function finalizeWorkspace(ws) {
  const tag = ws.owner.padEnd(30).slice(0, 30);
  console.log(`  [${tag}] Finalizing...`);
  try {
    const result = spriteExecRetry(ws.spriteName, [
      '[ -d /home/sprite/.claude/projects/-home-claude ] && mv /home/sprite/.claude/projects/-home-claude /home/sprite/.claude/projects/-home-sprite || true',
      'sudo ln -sfn /home/sprite /home/claude',
      'sudo chown -R sprite:sprite /home/sprite/ 2>/dev/null || true',
      'rm -rf /tmp/jfs',
      'du -sh /home/sprite/',
      'find /home/sprite -type f 2>/dev/null | wc -l',
    ].join(' && '), { timeout: 600_000 });
    console.log(`  [${tag}] Done: ${result.replace(/\n/g, ' | ')}`);
    return { status: 'success', owner: ws.owner, workspaceId: ws.workspaceId };
  } catch (e) {
    console.log(`  [${tag}] Finalize failed: ${e.message?.slice(0, 100)}`);
    return { status: 'failed', owner: ws.owner, workspaceId: ws.workspaceId, error: e.message };
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const workspaces = ENV === 'prod' ? PROD_WORKSPACES : STAGING_WORKSPACES;
  let filtered = WORKSPACE_FILTER
    ? workspaces.filter((w) => w.workspaceId === WORKSPACE_FILTER)
    : workspaces;

  if (filtered.length === 0) {
    console.error(WORKSPACE_FILTER
      ? `No workspace found with ID: ${WORKSPACE_FILTER}`
      : `No workspaces configured for ${ENV}.`);
    process.exit(1);
  }

  // Validate CF API token before starting
  if (!DRY_RUN) {
    console.log('Validating CF API token...');
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/user', {
        headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
      });
      const data = await res.json();
      if (!data.success) {
        console.error('CF API token is invalid or expired. Run: npx wrangler login');
        process.exit(1);
      }
      console.log(`Token valid (${data.result.email}).`);
    } catch (e) {
      console.error(`Token validation failed: ${e.message}`);
      process.exit(1);
    }
  }

  console.log(`\nJuiceFS → Sprites Migration`);
  console.log(`Environment: ${ENV}`);
  console.log(`Workspaces:  ${filtered.length}${DRY_RUN ? ' (dry run)' : ''}`);
  console.log('═'.repeat(60));

  if (DRY_RUN) {
    for (const ws of filtered) {
      const spriteName = computeSpriteName(ws.workspaceId);
      console.log(`  ${ws.owner}: ${ws.workspaceId} → ${spriteName}`);
    }
    return;
  }

  // ── Phase 1: Setup ──
  const running = [];
  const setupFailed = [];

  if (!SKIP_SETUP) {
    console.log('\n── Phase 1: Setup (sequential) ──');
    for (const ws of filtered) {
      try {
        running.push(await setupWorkspace(ws));
      } catch (e) {
        console.error(`  [${ws.owner}] SETUP FAILED: ${e.message}`);
        if (VERBOSE && e.stderr) console.error(`  stderr: ${e.stderr}`);
        setupFailed.push({ status: 'failed', owner: ws.owner, workspaceId: ws.workspaceId, error: e.message });
      }
    }
    console.log(`\n  Setup complete: ${running.length} syncs launched, ${setupFailed.length} failed`);
  } else {
    console.log('\n── Phase 1: Skipped (--skip-setup) ──');
    for (const ws of filtered) {
      running.push({
        ...ws,
        spriteName: computeSpriteName(ws.workspaceId),
        syncStartedAt: Date.now(),
      });
    }
  }

  // ── Phase 2: Poll ──
  if (running.length > 0) {
    console.log(`\n── Phase 2: Polling ${running.length} syncs ──`);
    const { completed, failed: pollFailed } = pollSyncs(running);
    console.log(`\n  Poll complete: ${completed.length} synced, ${pollFailed.length} failed`);

    // ── Phase 3: Finalize ──
    if (completed.length > 0) {
      console.log(`\n── Phase 3: Finalizing ${completed.length} workspaces ──`);
      const results = [];
      for (const ws of completed) {
        results.push(finalizeWorkspace(ws));
      }

      // Cleanup JuiceFS binary
      console.log(`\nCleaning up JuiceFS from ${results.filter(r => r.status === 'success').length} sprites...`);
      for (const r of results.filter(r => r.status === 'success')) {
        try {
          spriteExec(computeSpriteName(r.workspaceId),
            'sudo rm -f /usr/local/bin/juicefs && rm -rf /var/jfs /root/.juicefs /home/sprite/.juicefs 2>/dev/null || true');
        } catch { /* best effort */ }
      }

      // Summary
      const allResults = [...results, ...pollFailed, ...setupFailed];
      console.log(`\n${'═'.repeat(60)}`);
      console.log('Summary:');
      const succeeded = allResults.filter((r) => r.status === 'success');
      const allFailed = allResults.filter((r) => r.status === 'failed');
      if (succeeded.length) console.log(`  Succeeded: ${succeeded.length}`);
      if (allFailed.length) {
        console.log(`  Failed:    ${allFailed.length}`);
        for (const f of allFailed) console.log(`    - ${f.owner} (${f.workspaceId}): ${f.error}`);
      }
      if (allFailed.length > 0) process.exit(1);
    }
  }
}

main().catch((err) => { console.error('Fatal error:', err); process.exit(1); });
