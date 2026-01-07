/**
 * Admin CLI Worker
 *
 * Local-only worker for querying environment data.
 * Uses remote KV bindings to query the live KV namespace.
 *
 * Usage:
 *   npm run admin:staging     # Query staging
 *   npm run admin:prod        # Query production
 *   npm run admin:dev-illiana # Query dev-illiana
 *   npm run admin:dev-miguel  # Query dev-miguel
 *
 * Then curl the endpoints:
 *   curl http://localhost:8787/users
 *   curl http://localhost:8787/kv-keys
 */

import type { KVNamespace } from '@cloudflare/workers-types';

interface Env {
	EMAIL_TO_USER: KVNamespace;
	TARGET_HOST: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		try {
			if (path === '/' || path === '/help') {
				return jsonResponse({
					name: 'Chiridion Admin CLI',
					description: 'Local worker for querying live KV via remote bindings',
					targetHost: env.TARGET_HOST,
					usage: [
						'npm run admin:staging',
						'npm run admin:prod',
						'npm run admin:dev-illiana',
					],
					endpoints: {
						'/': 'This help message',
						'/users': 'List all users (email -> userId mappings from KV)',
						'/kv-keys': 'List all KV keys (with optional ?prefix=)',
						'/kv/:key': 'Get value for a specific KV key',
					},
				});
			}

			if (path === '/users') {
				return await listUsers(env);
			}

			if (path === '/kv-keys') {
				const prefix = url.searchParams.get('prefix') || undefined;
				return await listKVKeys(env, prefix);
			}

			if (path.startsWith('/kv/')) {
				const key = decodeURIComponent(path.slice(4));
				return await getKVValue(env, key);
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

// List all users from KV email mappings
async function listUsers(env: Env): Promise<Response> {
	const users: Array<{ email: string; userId: string }> = [];

	let cursor: string | undefined;
	while (true) {
		const list = await env.EMAIL_TO_USER.list({ prefix: 'email:', cursor });
		for (const key of list.keys) {
			const email = key.name.replace('email:', '');
			const userId = await env.EMAIL_TO_USER.get(key.name);
			if (userId) {
				users.push({ email, userId });
			}
		}
		if (list.list_complete) break;
		cursor = list.cursor;
	}

	return jsonResponse({
		targetHost: env.TARGET_HOST,
		count: users.length,
		users,
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
