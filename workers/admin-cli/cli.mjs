#!/usr/bin/env node
/**
 * Admin CLI - Query live Chiridion environments
 *
 * Usage:
 *   ./cli.mjs [env] [endpoint] [jq-filter]
 *
 * Examples:
 *   ./cli.mjs dev-illiana overview
 *   ./cli.mjs staging orgs
 *   ./cli.mjs prod users '.users[] | {name, email}'
 *   ./cli.mjs dev-illiana orgs '.orgs[] | {org_id: .id, name: .name}'
 *
 * Environments: staging (default), prod, dev-illiana, dev-miguel
 * Endpoints: overview, orgs, users, threads, kv-keys
 */

import { spawn } from 'child_process';
import { createServer } from 'net';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Cloudflare constants (same as worker)
const CF_ACCOUNT_ID = '85bbd288051330fb51ee1c86031a299b';
const CF_DISPATCH_NAMESPACE = 'chiridion-platform';

const ENVIRONMENTS = ['staging', 'prod', 'dev-illiana', 'dev-miguel'];
const ENDPOINTS = ['overview', 'orgs', 'users', 'threads', 'kv-keys', 'r2/list', 'r2/backup', 'workers'];

// Direct API endpoints that don't need wrangler/bindings
const _DIRECT_API_ENDPOINTS = ['workers'];

// Get OAuth token from wrangler config
function getWranglerToken() {
	const configPath = join(homedir(), 'Library/Preferences/.wrangler/config/default.toml');
	if (!existsSync(configPath)) {
		throw new Error('Wrangler config not found. Run "npx wrangler login" first.');
	}
	const content = readFileSync(configPath, 'utf-8');
	const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
	if (!match) {
		throw new Error('Could not extract oauth_token from wrangler config');
	}
	return match[1];
}

// List all scripts in dispatch namespace
async function listDispatchScripts(token) {
	const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/dispatch/namespaces/${CF_DISPATCH_NAMESPACE}/scripts`;
	const response = await fetch(url, {
		headers: { 'Authorization': `Bearer ${token}` }
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`API request failed: ${response.status} - ${text}`);
	}
	const data = await response.json();
	if (!data.success) {
		throw new Error(`API error: ${JSON.stringify(data.errors)}`);
	}
	return data.result || [];
}

// Handle workers endpoint directly (no wrangler needed)
async function handleWorkersDirectly(endpoint) {
	const token = getWranglerToken();
	const allScripts = await listDispatchScripts(token);

	// Check if filtering by org
	const orgMatch = endpoint.match(/^workers\/(.+)$/);
	if (orgMatch) {
		const orgId = orgMatch[1];
		return {
			org_id: orgId,
			warning: 'Org-scoped listing is unavailable because script names are no longer org-prefixed.',
			workers: allScripts.map(s => ({
				script_name: s.id,
				full_id: s.id,
				created_on: s.created_on,
				modified_on: s.modified_on
			})),
			total: allScripts.length
		};
	}

	// List all workers
	return {
		workers: allScripts.map(s => ({
			id: s.id,
			created_on: s.created_on,
			modified_on: s.modified_on
		})),
		total: allScripts.length
	};
}

// Check if endpoint can be handled directly (without wrangler)
function canHandleDirectly(endpoint) {
	return endpoint === 'workers' || endpoint.startsWith('workers/');
}

// Apply jq filter to JSON string
async function applyJqFilter(jsonStr, filter) {
	return new Promise((resolve, reject) => {
		const jq = spawn('jq', [filter], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let jqOut = '';
		let jqErr = '';
		jq.stdout.on('data', d => jqOut += d);
		jq.stderr.on('data', d => jqErr += d);

		jq.stdin.write(jsonStr);
		jq.stdin.end();

		jq.on('close', code => {
			if (code === 0) resolve(jqOut);
			else reject(new Error(`jq failed: ${jqErr}`));
		});
	});
}

function usage() {
	console.log(`
Admin CLI - Query live Chiridion environments

Usage:
  admin [env] [endpoint] [jq-filter]

Examples:
  admin dev-illiana overview
  admin staging orgs
  admin prod users '.users[] | {name, email}'
  admin dev-illiana orgs '.orgs[] | {org_id: .id, name: .name}'
  admin dev-illiana r2/backup/{orgId}
  admin staging r2/list '?prefix=abc123'
  admin dev-illiana workers
Environments: ${ENVIRONMENTS.join(', ')}
Endpoints: ${ENDPOINTS.join(', ')}, r2/info/{key}, r2/backup/{orgId}, workers/{orgId} (deprecated)
`);
	process.exit(1);
}

// Find a free port
async function findFreePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
		server.on('error', reject);
	});
}

// Wait for server to be ready
async function waitForServer(port, timeout = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			if (response.ok) return true;
		} catch {
			// Server not ready yet
		}
		await new Promise(r => setTimeout(r, 100));
	}
	throw new Error('Server failed to start within timeout');
}

// Main
async function main() {
	const args = process.argv.slice(2);

	if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
		usage();
	}

	// Parse arguments
	let env = 'staging';
	let endpoint = 'overview';
	let jqFilter = null;

	if (ENVIRONMENTS.includes(args[0])) {
		env = args.shift();
	}

	if (args.length > 0) {
		// Check for exact match or path-style endpoints like r2/backup/abc123 or workers/abc123
		const potentialEndpoint = args[0];
		if (ENDPOINTS.includes(potentialEndpoint) ||
			potentialEndpoint.startsWith('r2/') ||
			potentialEndpoint.startsWith('kv/') ||
			potentialEndpoint.startsWith('workers/')) {
			endpoint = args.shift();
		}
	}

	if (args.length > 0) {
		jqFilter = args.join(' ');
	}

	// Handle direct API endpoints (no wrangler needed)
	if (canHandleDirectly(endpoint)) {
		try {
			const data = await handleWorkersDirectly(endpoint);
			let result = JSON.stringify(data, null, 2);

			// Apply jq filter if provided
			if (jqFilter) {
				result = await applyJqFilter(result, jqFilter);
			}

			console.log(result.trim());
			return;
		} catch (e) {
			console.error(`Error: ${e.message}`);
			process.exit(1);
		}
	}

	// Find free port
	const port = await findFreePort();

	// Build wrangler command (--remote enables real DO RPC access)
	const wranglerArgs = [
		'dev',
		'--remote',
		'--config', 'workers/admin-cli/wrangler.jsonc',
		'--port', String(port),
		'--log-level', 'error',
	];

	if (env !== 'staging') {
		wranglerArgs.push('--env', env);
	}

	// Start wrangler in background
	const wrangler = spawn('npx', ['wrangler', ...wranglerArgs], {
		cwd: process.cwd(),
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: false,
	});

	let output = '';
	let error = '';
	wrangler.stdout.on('data', d => output += d);
	wrangler.stderr.on('data', d => error += d);

	const cleanup = () => {
		try {
			wrangler.kill('SIGTERM');
		} catch { /* ignore */ }
	};

	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);

	try {
		// Wait for server to be ready
		await waitForServer(port);

		// Make the request
		const response = await fetch(`http://127.0.0.1:${port}/${endpoint}`);
		if (!response.ok) {
			throw new Error(`Request failed: ${response.status} ${response.statusText}`);
		}

		let result = await response.text();

		// Apply jq filter if provided
		if (jqFilter) {
			try {
				const jq = spawn('jq', [jqFilter], {
					stdio: ['pipe', 'pipe', 'pipe'],
				});

				let jqOut = '';
				let jqErr = '';
				jq.stdout.on('data', d => jqOut += d);
				jq.stderr.on('data', d => jqErr += d);

				jq.stdin.write(result);
				jq.stdin.end();

				await new Promise((resolve, reject) => {
					jq.on('close', code => {
						if (code === 0) resolve();
						else reject(new Error(`jq failed: ${jqErr}`));
					});
				});

				result = jqOut;
			} catch (e) {
				console.error(`jq error: ${e.message}`);
				// Fall back to raw output
			}
		} else {
			// Pretty print JSON
			try {
				result = JSON.stringify(JSON.parse(result), null, 2);
			} catch { /* not JSON, keep as-is */ }
		}

		console.log(result.trim());
	} catch (e) {
		console.error(`Error: ${e.message}`);
		if (error) console.error(`Wrangler stderr: ${error}`);
		process.exit(1);
	} finally {
		cleanup();
	}
}

main();
