/**
 * Admin CLI Worker
 *
 * Local-only worker for querying environment data.
 * Uses direct Durable Object bindings (no DoRpcService).
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

import type { KVNamespace, R2Bucket, DurableObjectNamespace, DurableObjectStub } from '@cloudflare/workers-types';
import type {
	OrgDO,
	UserDO,
	User,
	UserOrg,
	Organization,
	OrgMember,
	OrgThread,
} from '../../main/src/auth';
import type { WorkspaceDO, Workspace } from '../../main/src/workspace';

interface Env {
	EMAIL_TO_USER: KVNamespace;
	R2: R2Bucket;
	ORG: DurableObjectNamespace<OrgDO>;
	USER: DurableObjectNamespace<UserDO>;
	WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
	TARGET_HOST: string;
}

// Helper to get typed DO stubs
function getOrgStub(env: Env, orgId: string): DurableObjectStub<OrgDO> {
	return env.ORG.get(env.ORG.idFromName(orgId)) as DurableObjectStub<OrgDO>;
}

function getUserStub(env: Env, userId: string): DurableObjectStub<UserDO> {
	return env.USER.get(env.USER.idFromName(userId)) as DurableObjectStub<UserDO>;
}

function getWorkspaceStub(env: Env, workspaceId: string): DurableObjectStub<WorkspaceDO> {
	return env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)) as DurableObjectStub<WorkspaceDO>;
}

// Types for admin responses
interface AdminUserSummary {
	id: string;
	email: string;
	name: string | null;
	created_at: number;
	org_count: number;
	is_superuser: boolean;
}

interface AdminOrgSummary extends Organization {
	member_count: number;
	workspace_count: number;
}

interface AdminThreadWithContext extends OrgThread {
	org_id: string;
	org_name: string;
	workspace_name: string;
}

interface AdminOverview {
	user_count: number;
	org_count: number;
	membership_count: number;
	users: AdminUserSummary[];
}

// Helper: Collect all user IDs from KV
async function collectAllUserIds(env: Env): Promise<string[]> {
	const allKeys: string[] = [];
	let cursor: string | undefined;

	while (true) {
		const list = await env.EMAIL_TO_USER.list({ prefix: 'email:', cursor });
		for (const key of list.keys) {
			allKeys.push(key.name);
		}
		if (list.list_complete || !list.cursor) break;
		cursor = list.cursor;
	}

	const userIdResults = await Promise.all(allKeys.map((key) => env.EMAIL_TO_USER.get(key)));
	return userIdResults.filter((id): id is string => id !== null && !id.startsWith('{'));
}

// Helper: Collect all org IDs from user memberships
async function collectAllOrgIds(env: Env): Promise<Set<string>> {
	const userIds = await collectAllUserIds(env);
	const orgIds = new Set<string>();

	await Promise.all(
		userIds.map(async (userId) => {
			try {
				const userStub = getUserStub(env, userId);
				const orgs = await userStub.getOrgs();
				for (const org of orgs) {
					orgIds.add(org.org_id);
				}
			} catch {
				// User may not exist
			}
		})
	);

	return orgIds;
}

// Admin helper: Get overview (aggregated counts)
async function getAdminOverview(env: Env): Promise<AdminOverview> {
	const userIds = await collectAllUserIds(env);
	const seenOrgIds = new Set<string>();
	let membershipCount = 0;

	const users: AdminUserSummary[] = [];

	await Promise.all(
		userIds.map(async (userId) => {
			try {
				const userStub = getUserStub(env, userId);
				const [profile, orgs] = await Promise.all([userStub.getProfile(), userStub.getOrgs()]);

				if (profile) {
					users.push({
						id: profile.id,
						email: profile.email,
						name: profile.name,
						created_at: profile.created_at,
						org_count: orgs.length,
						is_superuser: profile.is_superuser,
					});

					membershipCount += orgs.length;
					for (const org of orgs) {
						seenOrgIds.add(org.org_id);
					}
				}
			} catch {
				// User may not exist
			}
		})
	);

	return {
		user_count: users.length,
		org_count: seenOrgIds.size,
		membership_count: membershipCount,
		users,
	};
}

// Admin helper: Get all orgs with member/workspace counts
async function getAllOrgs(env: Env): Promise<AdminOrgSummary[]> {
	const orgIds = await collectAllOrgIds(env);
	const orgs: AdminOrgSummary[] = [];

	await Promise.all(
		Array.from(orgIds).map(async (orgId) => {
			try {
				const orgStub = getOrgStub(env, orgId);
				const [info, members, workspaces] = await Promise.all([
					orgStub.getInfo(),
					orgStub.getMembers(),
					orgStub.getWorkspaces(),
				]);

				if (info) {
					orgs.push({
						...info,
						member_count: members.length,
						workspace_count: workspaces.length,
					});
				}
			} catch {
				// Org may not exist
			}
		})
	);

	return orgs;
}

// Admin helper: Get all threads across all orgs
async function getAllThreads(env: Env): Promise<AdminThreadWithContext[]> {
	const orgIds = await collectAllOrgIds(env);
	const threads: AdminThreadWithContext[] = [];

	await Promise.all(
		Array.from(orgIds).map(async (orgId) => {
			try {
				const orgStub = getOrgStub(env, orgId);
				const [info, orgThreads, workspaces] = await Promise.all([
					orgStub.getInfo(),
					orgStub.getThreads(),
					orgStub.getWorkspaces(),
				]);

				if (info) {
					const workspaceMap = new Map(workspaces.map((ws) => [ws.id, ws.name]));

					for (const thread of orgThreads) {
						threads.push({
							...thread,
							org_id: orgId,
							org_name: info.name,
							workspace_name: workspaceMap.get(thread.workspace_id) || 'unknown',
						});
					}
				}
			} catch {
				// Org may not exist
			}
		})
	);

	return threads;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		try {
			if (path === '/' || path === '/help') {
				return jsonResponse({
					name: 'camelAI Admin CLI',
					description: 'Local worker for querying live data via direct DO bindings',
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
						'/orgs/{orgId}/add-member': 'Add member to org (POST: {userId, role?, actorId?})',
						'/threads/{threadId}/update': 'Update thread (POST: {created_by?, title?})',
					},
				});
			}

			// Overview endpoint
			if (path === '/overview') {
				const overview = await getAdminOverview(env);
				return jsonResponse({
					targetHost: env.TARGET_HOST,
					...overview,
				});
			}

			// Orgs endpoint
			if (path === '/orgs') {
				const orgs = await getAllOrgs(env);

				// Enrich with member details and workspaces
				const enrichedOrgs = await Promise.all(
					orgs.map(async (org) => {
						const orgStub = getOrgStub(env, org.id);
						const [members, workspaces] = await Promise.all([
							orgStub.getMembers(),
							orgStub.getWorkspaces(true),
						]);

						// Get user details for each member
						const memberDetails = await Promise.all(
							members.map(async (m) => {
								try {
									const userStub = getUserStub(env, m.user_id);
									const profile = await userStub.getProfile();
									return {
										user_id: m.user_id,
										email: profile?.email || 'unknown',
										name: profile?.name || null,
										role: m.role,
										joined_at: m.joined_at,
									};
								} catch {
									return {
										user_id: m.user_id,
										email: 'unknown',
										name: null,
										role: m.role,
										joined_at: m.joined_at,
									};
								}
							})
						);

						return {
							id: org.id,
							name: org.name,
							created_by: org.created_by,
							created_at: org.created_at,
							member_count: org.member_count,
							members: memberDetails,
							workspace_count: workspaces.length,
							workspaces: workspaces.map((ws) => ({
								id: ws.id,
								name: ws.name,
								created_at: ws.created_at,
								archived: ws.archived,
							})),
						};
					})
				);

				return jsonResponse({
					targetHost: env.TARGET_HOST,
					count: orgs.length,
					orgs: enrichedOrgs,
				});
			}

			// Users endpoint
			if (path === '/users') {
				const overview = await getAdminOverview(env);
				return jsonResponse({
					targetHost: env.TARGET_HOST,
					count: overview.users.length,
					users: overview.users,
				});
			}

			// Get user orgs: GET /users/{userId}/orgs
			const userOrgsMatch = path.match(/^\/users\/([^\/]+)\/orgs$/);
			if (userOrgsMatch) {
				const userId = decodeURIComponent(userOrgsMatch[1]!);
				const userStub = getUserStub(env, userId);
				const orgs = await userStub.getOrgs();
				return jsonResponse({
					userId,
					orgs,
				});
			}

			// Threads endpoint
			if (path === '/threads') {
				const threads = await getAllThreads(env);
				return jsonResponse({
					targetHost: env.TARGET_HOST,
					count: threads.length,
					threads,
				});
			}

			// Add member to org: POST /orgs/{orgId}/add-member
			const addMemberMatch = path.match(/^\/orgs\/([^\/]+)\/add-member$/);
			if (addMemberMatch && request.method === 'POST') {
				const orgId = decodeURIComponent(addMemberMatch[1]!);
				const body = (await request.json()) as { userId?: string; role?: string; actorId?: string };
				if (!body.userId) {
					return jsonResponse({ error: 'userId required' }, 400);
				}

				// Validate user exists
				const userStub = getUserStub(env, body.userId);
				const profile = await userStub.getProfile();
				if (!profile) {
					return jsonResponse({ error: 'User not found' }, 404);
				}

				const role = (body.role || 'member') as 'admin' | 'member';
				const actorId = body.actorId || 'admin-cli';

				// Add to org
				const orgStub = getOrgStub(env, orgId);
				await orgStub.addMember(body.userId, role, actorId);

				// Add org membership to user
				await userStub.addOrg(orgId, role, null);

				return jsonResponse({
					success: true,
					orgId,
					userId: body.userId,
					role,
				});
			}

			// Update thread: POST /threads/{threadId}/update
			const updateThreadMatch = path.match(/^\/threads\/([^\/]+)\/update$/);
			if (updateThreadMatch && request.method === 'POST') {
				const threadId = decodeURIComponent(updateThreadMatch[1]!);
				const body = (await request.json()) as { title?: string; created_by?: string };
				if (!body.title && !body.created_by) {
					return jsonResponse({ error: 'At least one of title or created_by required' }, 400);
				}

				// Search for thread in all orgs
				const orgIds = await collectAllOrgIds(env);
				let result: OrgThread | null = null;

				for (const orgId of orgIds) {
					const orgStub = getOrgStub(env, orgId);
					const thread = await orgStub.getThread(threadId);
					if (thread) {
						const updated = await orgStub.adminUpdateThread(threadId, body, 'admin-cli');
						result = updated;
						break;
					}
				}

				if (!result) {
					return jsonResponse({ error: 'Thread not found', threadId }, 404);
				}

				return jsonResponse({
					success: true,
					thread: result,
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
		return jsonResponse(
			{
				orgId,
				backupKey,
				exists: false,
				message: 'No backup found for this org',
			},
			404
		);
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
