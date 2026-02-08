#!/usr/bin/env node
/**
 * Deploy script for main worker to staging or prod.
 *
 * This script:
 * 1. Copies the environment-specific wrangler config to build/server/
 * 2. Fixes paths to be relative to build/server/
 * 3. Updates the .wrangler/deploy/config.json redirect
 * 4. Runs wrangler deploy
 *
 * Usage: node scripts/deploy-main.mjs [staging|prod]
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const env = process.argv[2];
const validEnvs = ['staging', 'prod', 'dev-miguel', 'dev-illiana'];
if (!env || !validEnvs.includes(env)) {
  console.error('Usage: node scripts/deploy-main.mjs [staging|prod|dev-miguel|dev-illiana]');
  process.exit(1);
}

const sourceConfig = path.join(rootDir, `wrangler.${env}.jsonc`);
const targetConfig = path.join(rootDir, 'build/server', `wrangler.${env}.json`);
const redirectConfig = path.join(rootDir, '.wrangler/deploy/config.json');

// Check that build exists
if (!fs.existsSync(path.join(rootDir, 'build/server/index.js'))) {
  console.error('Build not found. Run "npm run build" first.');
  process.exit(1);
}

// Read the source config and fix paths for build/server context
console.log(`Reading ${sourceConfig}...`);
let configContent = fs.readFileSync(sourceConfig, 'utf8');

// Fix paths: main, assets directory, and Dockerfiles should be relative to build/server
configContent = configContent
  .replace(/"build\/server\/index\.js"/g, '"index.js"')
  .replace(/"build\/client"/g, '"../client"')
  // Fix all Dockerfile paths (./Dockerfile, ./containers/*/Dockerfile, etc.)
  .replace(/"\.\/([^"]*Dockerfile)"/g, '"../../$1"');

// Write to build/server
console.log(`Writing ${targetConfig}...`);
fs.mkdirSync(path.dirname(targetConfig), { recursive: true });
fs.writeFileSync(targetConfig, configContent);

// Update the redirect config
console.log(`Updating ${redirectConfig}...`);
fs.mkdirSync(path.dirname(redirectConfig), { recursive: true });
fs.writeFileSync(redirectConfig, JSON.stringify({
  configPath: `../../build/server/wrangler.${env}.json`,
  auxiliaryWorkers: []
}));

// Run wrangler deploy
console.log(`\nDeploying to ${env}...`);
try {
  execSync('npx wrangler deploy', {
    cwd: rootDir,
    stdio: 'inherit'
  });
} catch (error) {
  process.exit(error.status || 1);
}
