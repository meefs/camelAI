import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const serverBuildDir = path.join(repoRoot, 'build', 'server');

if (!fs.existsSync(serverBuildDir)) {
  console.error(
    'Missing build/server. Run this check after the production build has completed.',
  );
  process.exit(1);
}

function collectJavaScriptFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

const javaScriptFiles = collectJavaScriptFiles(serverBuildDir);
const forbiddenSmithyBrowserConfigPatterns = [
  /\b(?:const|let|var)\s+loadConfig\s*=\s*no\b/,
  /\bloadConfig\s*=\s*no\s*;/,
  /\bHash\.bind\b/,
];
const realSmithyLoadConfigPattern =
  /\b(?:const|let|var)\s+loadConfig\s*=\s*\(\s*\{\s*environmentVariableSelector\b/;
const awsSdkBedrockProviderPattern =
  /\b(?:BedrockRuntimeClient|ConverseStreamCommand|fromNodeProviderChain)\b/;

const matches = [];
let hasRealSmithyLoadConfig = false;
let hasAwsSdkBedrockProvider = false;

for (const file of javaScriptFiles) {
  const source = fs.readFileSync(file, 'utf8');

  if (realSmithyLoadConfigPattern.test(source)) {
    hasRealSmithyLoadConfig = true;
  }

  if (awsSdkBedrockProviderPattern.test(source)) {
    hasAwsSdkBedrockProvider = true;
  }

  for (const pattern of forbiddenSmithyBrowserConfigPatterns) {
    if (pattern.test(source)) {
      matches.push(path.relative(repoRoot, file));
      break;
    }
  }
}

if (matches.length > 0) {
  console.error(
    [
      'Pi Bedrock build check failed.',
      'The server build contains Smithy browser config output, where loadConfig is a sentinel instead of a callable function.',
      'This regresses Bedrock BYOK runtime support and can surface as "loadConfig is not a function".',
      '',
      ...matches.map((file) => `- ${file}`),
    ].join('\n'),
  );
  process.exit(1);
}

if (hasAwsSdkBedrockProvider && !hasRealSmithyLoadConfig) {
  console.error(
    [
      'Pi Bedrock build check failed.',
      'The server build did not contain Smithy\'s callable loadConfig implementation.',
      'Verify @smithy/core/config is still resolved to the node/server entry for the Cloudflare Worker build.',
    ].join('\n'),
  );
  process.exit(1);
}

if (hasAwsSdkBedrockProvider) {
  console.log('Pi Bedrock build check passed with Smithy node/server config.');
} else {
  console.log('Pi Bedrock build check passed with Worker-native Bedrock provider.');
}
