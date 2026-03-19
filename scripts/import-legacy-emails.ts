import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FOUNDER_EMAILS = [
  'admin@example.com',
  'owner@example.com',
  '1033072+Vercantez@users.noreply.github.com',
];

function printUsageAndExit(): never {
  console.error(
    'Usage: bun run scripts/import-legacy-emails.ts <path-to-csv> [--env <prod|staging|dev-illiana|dev-miguel|local>]'
  );
  process.exit(1);
}

function normalizeEmail(value: string): string | null {
  const normalized = value.trim().replace(/^"+|"+$/g, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function extractEmailsFromCsv(csv: string): string[] {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  const startIndex = lines[0].toLowerCase() === 'email' ? 1 : 0;
  const emails: string[] = [];

  for (const line of lines.slice(startIndex)) {
    const rawEmail = line.split(',')[0] ?? '';
    const normalizedEmail = normalizeEmail(rawEmail);
    if (normalizedEmail) {
      emails.push(normalizedEmail);
    }
  }

  return emails;
}

function normalizeWranglerEnv(value: string | undefined): string | undefined {
  if (!value || value === 'development') {
    return undefined;
  }
  if (value === 'local') {
    console.error('Error: --env local is not supported. Local KV is managed by Miniflare and cannot be seeded with this script. Use --env dev-illiana or --env dev-miguel instead.');
    process.exit(1);
  }
  if (value === 'production') {
    return 'prod';
  }
  return value;
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let env: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--env') {
      env = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('--env=')) {
      env = arg.slice('--env='.length);
      continue;
    }

    positional.push(arg);
  }

  const csvPath = positional[0];
  if (!csvPath) {
    printUsageAndExit();
  }

  return { csvPath, env: normalizeWranglerEnv(env) };
}

async function main() {
  const { csvPath, env } = parseArgs(process.argv.slice(2));
  const absoluteCsvPath = resolve(csvPath);
  const csv = await readFile(absoluteCsvPath, 'utf8');

  const emails = new Set(extractEmailsFromCsv(csv));
  for (const founderEmail of FOUNDER_EMAILS) {
    const normalizedEmail = normalizeEmail(founderEmail);
    if (normalizedEmail) {
      emails.add(normalizedEmail);
    }
  }

  if (emails.size === 0) {
    throw new Error(`No emails found in ${absoluteCsvPath}`);
  }

  const payload = Array.from(emails)
    .sort()
    .map((email) => ({
      key: `legacy_user:${email}`,
      value: '1',
    }));

  const tempDirectory = await mkdtemp(join(tmpdir(), 'legacy-user-import-'));
  const payloadPath = join(tempDirectory, 'legacy-users.json');
  const wranglerPath = resolve(
    process.cwd(),
    process.platform === 'win32'
      ? 'node_modules/.bin/wrangler.cmd'
      : 'node_modules/.bin/wrangler'
  );

  if (!existsSync(wranglerPath)) {
    throw new Error(`Wrangler binary not found at ${wranglerPath}`);
  }

  try {
    await writeFile(payloadPath, JSON.stringify(payload, null, 2));

    const wranglerArgs = [
      'kv',
      'bulk',
      'put',
      payloadPath,
      '--binding',
      'APP_KV',
      '--config',
      'wrangler.jsonc',
      '--remote',
    ];
    if (env) {
      wranglerArgs.push('--env', env);
    }

    console.log(
      `Importing ${payload.length} legacy user emails into APP_KV${env ? ` (${env})` : ''}...`
    );
    execFileSync(wranglerPath, wranglerArgs, { stdio: 'inherit' });
    console.log(`Imported ${payload.length} legacy user emails.`);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Legacy email import failed.'
  );
  process.exitCode = 1;
});
