import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { defineConfig } from 'vitest/config';

const smithyCoreConfigNodeEntry = path.resolve(
  'node_modules/@smithy/core/dist-es/submodules/config/index.js',
);

const bedrockDevVarNames = new Set([
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_DEFAULT_REGION',
  'AWS_REGION',
  'BEDROCK_API_KEY',
  'BEDROCK_AWS_REGION',
  'BEDROCK_PI_TEST_MODEL',
  'BEDROCK_TEST_MODEL',
  'BEDROCK_TEST_REGION',
  'AI_GATEWAY_AUTH_TOKEN',
  'CF_ACCOUNT_ID',
  'CF_API_TOKEN',
  // NOTE: CF_DISPATCH_NAMESPACE, CF_WORKER_NAME, WORKER_BASE_URL and the LOCAL_APP_*
  // hosts are intentionally NOT whitelisted. They are pinned in wrangler.test.jsonc so a
  // developer's ambient .dev.vars/env (e.g. CF_DISPATCH_NAMESPACE=chiridion-platform-staging)
  // can't redirect real eval deploys out of the dedicated chiridion-platform-evals
  // testing-grounds namespace or change the app host they are served on.
  'CF_GATEWAY_NAME',
  'CF_GATEWAY_TOKEN',
  'CUSTOM_EVAL_PROMPT',
  'CUSTOM_EVAL_PROJECT',
  'CUSTOM_EVAL_REQUIRED_TRANSCRIPT_SUBSTRINGS',
  'EVAL_REAL_DEPLOY',
  'EVAL_CUSTOM_API',
  'EVAL_CUSTOM_API_KEY',
  'EVAL_CUSTOM_BASE_URL',
  'EVAL_CUSTOM_MODEL_ID',
  'EVAL_ENFORCE_SIGNAL',
  'EVAL_MAX_ASSISTANT_TURNS',
  'EVAL_MAX_BAD_TOOL_CALLS',
  'EVAL_MAX_SDK_TURNS',
  'EVAL_MODEL',
  'EVAL_TIMEOUT_MS',
  'RUN_AGENT_EVALS',
  'RUN_PROJECT_BUILD_SANDBOX_REPRO',
  'RUN_SANDBOX_EVAL_PROTOTYPE',
]);

function parseDevVars(source: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function loadBedrockDevVars(): Record<string, string> {
  const devVarPaths = [
    process.env.CHIRIDION_DEV_VARS_PATH,
    path.resolve('.dev.vars'),
    path.join(os.homedir(), 'chiridion/chiridion-2/.dev.vars'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const bindings: Record<string, string> = {};
  for (const devVarPath of devVarPaths) {
    if (!fs.existsSync(devVarPath)) continue;

    const parsed = parseDevVars(fs.readFileSync(devVarPath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (bedrockDevVarNames.has(key) && value) {
        bindings[key] = value;
      }
    }
  }

  for (const key of bedrockDevVarNames) {
    const value = process.env[key];
    if (value) {
      bindings[key] = value;
    }
  }

  return bindings;
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        bindings: loadBedrockDevVars(),
        compatibilityDate: '2025-12-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          EVAL_SANDBOX: {
            className: 'EvalSandbox',
            useSQLite: true,
            container: { imageName: 'camelai-eval-sandbox:latest' },
          },
          PROJECT_BUILD_SANDBOX: {
            className: 'ProjectBuildSandbox',
            useSQLite: true,
            container: { imageName: 'camelai-eval-sandbox:latest' },
          },
        },
        cachePersist: false,
        d1Persist: false,
        durableObjectsPersist: false,
        kvPersist: false,
        r2Persist: false,
        workflowsPersist: false,
      },
    }),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      {
        find: '@smithy/core/config',
        replacement: smithyCoreConfigNodeEntry,
      },
      { find: '../../../.open-next/worker.js', replacement: path.resolve(__dirname, 'workers/main/src/__mocks__/opennext-handler.ts') },
      // Mock MCP handler to avoid @modelcontextprotocol/sdk ajv compatibility issues in workers runtime
      // Match any path ending in mcp-handler.js from the workers/main/src directory
      { find: /.*\/mcp-handler\.js$/, replacement: path.resolve(__dirname, 'workers/main/src/__mocks__/mcp-handler.ts') },
    ],
  },
  test: {
    include: ['workers/**/tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
