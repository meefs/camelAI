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

import type { KVNamespace } from '@cloudflare/workers-types';
import type { DoRpcService } from '../../main/src/rpc-service';

interface Env {
	EMAIL_TO_USER: KVNamespace;
	RPC: Service<DoRpcService>;
	TARGET_HOST: string;
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

			// KV-based endpoints (direct KV access)
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
