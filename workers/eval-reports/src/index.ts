/**
 * camelAI eval reports — results store + viewer at evals.camelai.dev.
 *
 * Evals run LOCALLY (bun run test:eval <id> — needs Docker + .dev.vars); this
 * worker only keeps the shared history: the reporter
 * (scripts/report-eval-run.mjs, auto-invoked with EVAL_REPORT=1) uploads each
 * finished run's transcript artifact + log and posts run metadata, which is
 * folded into a run.json in R2. The dashboard and JSON API are read-only.
 *
 * Everything (reads and uploads) sits behind Cloudflare Access — humans log in,
 * CI/scripts use an Access service token — and the worker re-validates the
 * Access JWT, so there are no worker secrets at all.
 */
import { Hono } from "hono";

import { verifyAccess } from "./access";
import { batchIdForRun, summarizeBatchRuns } from "./batches";
import { ingestResults, type ArtifactFile } from "./ingest";
import type { BatchSummary, CompleteRequest, Run } from "./types";

import skillDoc from "../SKILL.md?raw";

const RUNS_PREFIX = "runs/";
const BATCH_RUNS_PREFIX = "batch-runs/";
const BATCH_SUMMARIES_PREFIX = "batch-summaries/";
const RECENT_BATCHES_KEY = "batch-index/recent.json";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TEXT_FIELD_MAX = 300;
const BATCH_SUMMARY_WRITE_ATTEMPTS = 5;
const RECENT_BATCH_INDEX_CAP = 200;
const RECENT_BATCH_REMOVAL_CAP = 200;
const LEGACY_RUN_SEARCH_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

interface BatchSummaryTombstone {
	id: string;
	deleted: true;
	_revision: number;
}

type StoredBatchSummary = BatchSummary & { _revision?: number };

interface BatchSummaryState {
	summary: BatchSummary | null;
	revision: number;
}

interface RecentBatchEntry {
	id: string;
	kind: "batch" | "singleton";
	createdAt: string;
	revision?: number;
}

interface RecentBatchRemoval {
	id: string;
	kind: "batch" | "singleton";
	createdAt: string;
	revision?: number;
	removedAt: string;
}

interface RecentBatchIndex {
	entries: RecentBatchEntry[];
	removals?: RecentBatchRemoval[];
}

function runKey(runId: string, rel: string): string {
	return `${RUNS_PREFIX}${runId}/${rel}`;
}

function batchRunPrefix(batchId: string): string {
	return `${BATCH_RUNS_PREFIX}${batchId}/`;
}

function batchRunKey(batchId: string, runId: string): string {
	return `${batchRunPrefix(batchId)}${runId}.json`;
}

function batchSummaryKey(batchId: string): string {
	return `${BATCH_SUMMARIES_PREFIX}${batchId}.json`;
}

/** Strip any path components from a client-supplied artifact name. */
function baseName(name: string): string {
	return name.split("/").pop() ?? "";
}

function cleanTextField(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.slice(0, TEXT_FIELD_MAX);
}

/**
 * Plain JSON response for payloads carrying Run objects. Run's recursive
 * JsonValue `details` fields send Hono's c.json type inference into
 * "excessively deep" territory, so run-bearing endpoints serialize directly.
 */
function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

async function readRun(env: Env, runId: string): Promise<Run | null> {
	const object = await env.RUNS_BUCKET.get(runKey(runId, "run.json"));
	if (!object) return null;
	try {
		return (await object.json()) as Run;
	} catch {
		return null;
	}
}

async function listRunIds(env: Env): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | undefined;
	do {
		const listed = await env.RUNS_BUCKET.list({
			prefix: RUNS_PREFIX,
			delimiter: "/",
			cursor,
		});
		for (const p of listed.delimitedPrefixes) {
			const id = p.slice(RUNS_PREFIX.length).replace(/\/$/, "");
			if (id) ids.push(id);
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
	ids.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
	return ids;
}

function runBoundaryKey(timestamp: number): string {
	const stamp = new Date(timestamp)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z")
		.replace("T", "-");
	return `${RUNS_PREFIX}eval-${stamp}`;
}

async function listRunIdsAfter(
	env: Env,
	startAfter: string,
	limit: number,
): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | undefined;
	do {
		const listed = await env.RUNS_BUCKET.list({
			prefix: RUNS_PREFIX,
			delimiter: "/",
			startAfter,
			cursor,
			limit: Math.max(limit - ids.length, 1),
		});
		for (const prefix of listed.delimitedPrefixes) {
			const id = prefix.slice(RUNS_PREFIX.length).replace(/\/$/, "");
			if (id) ids.push(id);
		}
		if (ids.length >= limit) break;
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
	return ids.slice(0, limit);
}

/**
 * R2 lists ascending and has no reverse option. Reporter-generated run ids
 * embed UTC time, so find a cutoff that contains at most `limit` tail entries
 * using bounded startAfter probes instead of scanning the complete history.
 */
async function listNewestRunIds(env: Env, limit: number): Promise<string[]> {
	const probeLimit = limit + 1;
	const ceiling = Date.now() + DAY_MS;
	let newerCutoff = ceiling;
	let best: string[] = [];
	let olderCutoff = 0;
	const allProbe = await listRunIdsAfter(
		env,
		runBoundaryKey(olderCutoff),
		probeLimit,
	);
	if (allProbe.length <= limit) {
		return allProbe.sort((a, b) => b.localeCompare(a));
	}

	while (newerCutoff - olderCutoff > 1_000) {
		const midpoint = Math.floor((olderCutoff + newerCutoff) / 2);
		const ids = await listRunIdsAfter(
			env,
			runBoundaryKey(midpoint),
			probeLimit,
		);
		if (ids.length > limit) {
			olderCutoff = midpoint;
		} else {
			newerCutoff = midpoint;
			best = ids;
		}
	}

	return best.sort((a, b) => b.localeCompare(a)).slice(0, limit);
}

async function putBatchSummary(
	env: Env,
	summary: StoredBatchSummary | BatchSummaryTombstone,
	onlyIf?: R2Conditional | Headers,
): Promise<boolean> {
	const written = await env.RUNS_BUCKET.put(
		batchSummaryKey(summary.id),
		JSON.stringify(summary),
		{
			httpMetadata: { contentType: "application/json; charset=utf-8" },
			...(onlyIf ? { onlyIf } : {}),
		},
	);
	return written !== null;
}

function isBatchSummaryTombstone(
	value: StoredBatchSummary | BatchSummaryTombstone,
): value is BatchSummaryTombstone {
	return "deleted" in value && value.deleted === true;
}

function storedBatchRevision(
	value: StoredBatchSummary | BatchSummaryTombstone | undefined,
): number {
	const revision = value?._revision;
	return typeof revision === "number" && Number.isInteger(revision) && revision >= 0
		? revision
		: 0;
}

function publicBatchSummary(summary: StoredBatchSummary): BatchSummary {
	const { _revision: _storedRevision, ...value } = summary;
	return value;
}

async function readBatchSummary(
	env: Env,
	batchId: string,
): Promise<BatchSummary | null> {
	const object = await env.RUNS_BUCKET.get(batchSummaryKey(batchId));
	if (!object) return null;
	try {
		const stored = (await object.json()) as
			| StoredBatchSummary
			| BatchSummaryTombstone;
		if (isBatchSummaryTombstone(stored)) return null;
		return await normalizeBatchSummary(env, publicBatchSummary(stored));
	} catch {
		return null;
	}
}

async function normalizeBatchSummary(
	env: Env,
	summary: BatchSummary,
): Promise<BatchSummary> {
	if (Array.isArray(summary.evalTargets)) return summary;
	const runs = await readBatchRuns(env, summary.id);
	const rebuilt = summarizeBatchRuns(summary.id, runs);
	return rebuilt ?? { ...summary, evalTargets: [] };
}

function recentBatchEntryKey(entry: { id: string; kind: "batch" | "singleton" }): string {
	return `${entry.kind}:${entry.id}`;
}

function parseRecentBatchIndex(value: unknown): RecentBatchIndex {
	if (!value || typeof value !== "object") return { entries: [], removals: [] };
	const entries = (value as { entries?: unknown }).entries;
	const removals = (value as { removals?: unknown }).removals;
	const parsedEntries = (Array.isArray(entries) ? entries : [])
		.filter(
			(entry): entry is RecentBatchEntry =>
				Boolean(
					entry &&
						typeof entry === "object" &&
						typeof (entry as RecentBatchEntry).id === "string" &&
						((entry as RecentBatchEntry).kind === "batch" ||
							(entry as RecentBatchEntry).kind === "singleton") &&
						typeof (entry as RecentBatchEntry).createdAt === "string",
				),
		)
		.sort(
			(a, b) =>
				b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
		)
		.slice(0, RECENT_BATCH_INDEX_CAP);
	const parsedRemovals = (Array.isArray(removals) ? removals : [])
		.filter(
			(removal): removal is RecentBatchRemoval =>
				Boolean(
					removal &&
						typeof removal === "object" &&
						typeof (removal as RecentBatchRemoval).id === "string" &&
						((removal as RecentBatchRemoval).kind === "batch" ||
							(removal as RecentBatchRemoval).kind === "singleton") &&
						typeof (removal as RecentBatchRemoval).createdAt === "string" &&
						typeof (removal as RecentBatchRemoval).removedAt === "string",
				),
		)
		.sort((a, b) => b.removedAt.localeCompare(a.removedAt))
		.slice(0, RECENT_BATCH_REMOVAL_CAP);
	return { entries: parsedEntries, removals: parsedRemovals };
}

async function readRecentBatchIndex(env: Env): Promise<RecentBatchEntry[]> {
	const object = await env.RUNS_BUCKET.get(RECENT_BATCHES_KEY);
	if (!object) return [];
	try {
		return parseRecentBatchIndex(await object.json()).entries;
	} catch {
		return [];
	}
}

function recentMutationIsNewer(
	candidate: RecentBatchEntry | RecentBatchRemoval,
	current: RecentBatchEntry | RecentBatchRemoval,
): boolean {
	if (candidate.kind === "batch") {
		return (candidate.revision ?? 0) > (current.revision ?? 0);
	}
	return candidate.createdAt > current.createdAt;
}

async function mutateRecentBatchIndex(
	env: Env,
	mutation:
		| { type: "upsert"; entry: RecentBatchEntry }
		| { type: "remove"; removal: RecentBatchRemoval },
): Promise<void> {
	for (let attempt = 0; attempt < BATCH_SUMMARY_WRITE_ATTEMPTS; attempt += 1) {
		const existing = await env.RUNS_BUCKET.get(RECENT_BATCHES_KEY);
		let index: RecentBatchIndex = { entries: [], removals: [] };
		if (existing) {
			try {
				index = parseRecentBatchIndex(await existing.json());
			} catch {
				index = { entries: [], removals: [] };
			}
		}
		const candidate =
			mutation.type === "upsert" ? mutation.entry : mutation.removal;
		const key = recentBatchEntryKey(candidate);
		const currentEntry = index.entries.find(
			(entry) => recentBatchEntryKey(entry) === key,
		);
		const currentRemoval = index.removals?.find(
			(removal) => recentBatchEntryKey(removal) === key,
		);
		let entries = index.entries;
		let removals = index.removals ?? [];
		if (mutation.type === "upsert") {
			if (
				(currentRemoval && !recentMutationIsNewer(mutation.entry, currentRemoval)) ||
				(currentEntry && recentMutationIsNewer(currentEntry, mutation.entry))
			) {
				return;
			}
			entries = [
				mutation.entry,
				...entries.filter((entry) => recentBatchEntryKey(entry) !== key),
			];
			removals = removals.filter(
				(removal) => recentBatchEntryKey(removal) !== key,
			);
		} else {
			if (
				(currentEntry && recentMutationIsNewer(currentEntry, mutation.removal)) ||
				(currentRemoval && !recentMutationIsNewer(mutation.removal, currentRemoval))
			) {
				return;
			}
			entries = entries.filter((entry) => recentBatchEntryKey(entry) !== key);
			removals = [
				mutation.removal,
				...removals.filter((removal) => recentBatchEntryKey(removal) !== key),
			];
		}
		const next: RecentBatchIndex = {
			entries: entries
				.sort(
					(a, b) =>
						b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
				)
				.slice(0, RECENT_BATCH_INDEX_CAP),
			removals: removals
				.sort((a, b) => b.removedAt.localeCompare(a.removedAt))
				.slice(0, RECENT_BATCH_REMOVAL_CAP),
		};
		const condition: R2Conditional | Headers = existing
			? { etagMatches: existing.etag }
			: new Headers({ "If-None-Match": "*" });
		const written = await env.RUNS_BUCKET.put(
			RECENT_BATCHES_KEY,
			JSON.stringify(next),
			{
				httpMetadata: { contentType: "application/json; charset=utf-8" },
				onlyIf: condition,
			},
		);
		if (written) return;
	}
	throw new Error("Failed to update recent batch index after concurrent writes");
}

async function recordRecentBatch(env: Env, entry: RecentBatchEntry): Promise<void> {
	await mutateRecentBatchIndex(env, { type: "upsert", entry });
}

async function removeRecentBatch(
	env: Env,
	entry: Omit<RecentBatchRemoval, "removedAt">,
): Promise<void> {
	await mutateRecentBatchIndex(env, {
		type: "remove",
		removal: { ...entry, removedAt: new Date().toISOString() },
	});
}

async function readBatchRuns(env: Env, batchId: string): Promise<Run[]> {
	const runs: Run[] = [];
	let cursor: string | undefined;
	do {
		const listed = await env.RUNS_BUCKET.list({
			prefix: batchRunPrefix(batchId),
			cursor,
		});
		for (const object of listed.objects) {
			const stored = await env.RUNS_BUCKET.get(object.key);
			if (!stored) continue;
			try {
				runs.push((await stored.json()) as Run);
			} catch {
				// Ignore corrupt member objects; the canonical run.json remains readable.
			}
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
	runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
	return runs;
}

async function recomputeBatchSummary(
	env: Env,
	batchId: string,
): Promise<BatchSummaryState> {
	for (let attempt = 0; attempt < BATCH_SUMMARY_WRITE_ATTEMPTS; attempt += 1) {
		const existing = await env.RUNS_BUCKET.get(batchSummaryKey(batchId));
		let stored: StoredBatchSummary | BatchSummaryTombstone | undefined;
		if (existing) {
			try {
				stored = (await existing.json()) as
					| StoredBatchSummary
					| BatchSummaryTombstone;
			} catch {
				stored = undefined;
			}
		}
		const revision = storedBatchRevision(stored) + 1;
		const runs = await readBatchRuns(env, batchId);
		const summary = summarizeBatchRuns(batchId, runs);
		if (!summary) {
			if (!existing) return { summary: null, revision: 0 };
			if (stored && isBatchSummaryTombstone(stored)) {
				return { summary: null, revision: stored._revision };
			}
			if (
				await putBatchSummary(
					env,
					{ id: batchId, deleted: true, _revision: revision },
					{ etagMatches: existing.etag },
				)
			) {
				return { summary: null, revision };
			}
			continue;
		}
		const condition: R2Conditional | Headers = existing
			? { etagMatches: existing.etag }
			: new Headers({ "If-None-Match": "*" });
		if (
			await putBatchSummary(
				env,
				{ ...summary, _revision: revision },
				condition,
			)
		) {
			return { summary, revision };
		}
	}
	throw new Error(`Failed to update batch summary after concurrent writes: ${batchId}`);
}

async function readRunsByIds(env: Env, ids: string[]): Promise<Run[]> {
	return (await Promise.all(ids.map((id) => readRun(env, id)))).filter(
		(run): run is Run => run !== null,
	);
}

async function summarizeLegacyRuns(env: Env, runs: Run[]): Promise<BatchSummary[]> {
	const grouped = new Map<string, Run[]>();
	for (const run of runs) {
		const id = batchIdForRun(run);
		const group = grouped.get(id);
		if (group) group.push(run);
		else grouped.set(id, [run]);
	}
	return (
		await Promise.all(
			[...grouped.entries()].map(async ([id, groupRuns]) => {
				if (groupRuns.some((run) => run.batchId === id)) {
					const stored = await readBatchSummary(env, id);
					if (stored) return stored;
				}
				return summarizeBatchRuns(id, groupRuns);
			}),
		)
	).filter((summary): summary is BatchSummary => summary !== null);
}

async function scanCanonicalBatchRuns(env: Env, batchId: string): Promise<Run[]> {
	const ids = await listRunIds(env);
	const runs = await readRunsByIds(env, ids);
	return runs.filter((run) => run.batchId === batchId);
}

async function indexBatchRun(
	env: Env,
	run: Run,
	recordRecent = true,
): Promise<RecentBatchEntry> {
	if (!run.batchId) {
		await env.RUNS_BUCKET.delete(batchRunKey(run.runId, run.runId));
		const state = await recomputeBatchSummary(env, run.runId);
		if (!state.summary && state.revision > 0) {
			await removeRecentBatch(env, {
				id: run.runId,
				kind: "batch",
				createdAt: "",
				revision: state.revision,
			});
		}
		const entry: RecentBatchEntry = {
			id: run.runId,
			kind: "singleton",
			createdAt: run.createdAt,
		};
		if (recordRecent) await recordRecentBatch(env, entry);
		return entry;
	}
	const batchId = run.batchId;
	await env.RUNS_BUCKET.put(batchRunKey(batchId, run.runId), JSON.stringify(run), {
		httpMetadata: { contentType: "application/json; charset=utf-8" },
	});
	const state = await recomputeBatchSummary(env, batchId);
	if (!state.summary) throw new Error(`Indexed batch has no summary: ${batchId}`);
	const entry: RecentBatchEntry = {
		id: batchId,
		kind: "batch",
		createdAt: state.summary.createdAt,
		revision: state.revision,
	};
	if (recordRecent) await recordRecentBatch(env, entry);
	return entry;
}

async function removeBatchRun(env: Env, batchId: string, runId: string): Promise<void> {
	await env.RUNS_BUCKET.delete(batchRunKey(batchId, runId));
	const state = await recomputeBatchSummary(env, batchId);
	if (state.summary) {
		await recordRecentBatch(env, {
			id: batchId,
			kind: "batch",
			createdAt: state.summary.createdAt,
			revision: state.revision,
		});
	} else {
		await removeRecentBatch(env, {
			id: batchId,
			kind: "batch",
			createdAt: "",
			revision: state.revision,
		});
	}
}

async function resolveRecentBatchEntry(
	env: Env,
	entry: RecentBatchEntry,
): Promise<BatchSummary | null> {
	if (entry.kind === "batch") return readBatchSummary(env, entry.id);
	const run = await readRun(env, entry.id);
	if (!run || run.batchId) return null;
	return summarizeBatchRuns(entry.id, [run]);
}

async function resolveRecentBatchSummaries(
	env: Env,
	entries: RecentBatchEntry[],
	limit: number,
): Promise<BatchSummary[]> {
	const summaries: BatchSummary[] = [];
	const seen = new Set<string>();
	let offset = 0;
	while (offset < entries.length && summaries.length < limit) {
		const remaining = limit - summaries.length;
		const chunk = entries.slice(offset, offset + remaining);
		offset += chunk.length;
		const resolved = await Promise.all(
			chunk.map((entry) => resolveRecentBatchEntry(env, entry)),
		);
		for (const summary of resolved) {
			if (!summary || seen.has(summary.id)) continue;
			seen.add(summary.id);
			summaries.push(summary);
		}
	}
	return summaries;
}

const app = new Hono<{ Bindings: Env; Variables: { identity?: string } }>();

app.use("*", async (c, next) => {
	if (c.env.CF_ACCESS_ENABLED === "0") {
		await next();
		return;
	}
	const identity = await verifyAccess(c.req.raw, {
		teamDomain: c.env.CF_ACCESS_TEAM_DOMAIN,
		aud: c.env.CF_ACCESS_AUD,
	});
	if (!identity) return c.json({ error: "Cloudflare Access required" }, 403);
	c.set("identity", identity.email ?? identity.commonName);
	await next();
});

// ---------------------------------------------------------------------------
// Upload plane (the reporter). Access already authenticated the caller.
// ---------------------------------------------------------------------------
app.put("/upload/:id/log", async (c) => {
	const runId = c.req.param("id");
	if (!RUN_ID_PATTERN.test(runId)) return c.json({ error: "Invalid run id" }, 400);
	await c.env.RUNS_BUCKET.put(runKey(runId, "output.log"), await c.req.arrayBuffer(), {
		httpMetadata: { contentType: "text/plain; charset=utf-8" },
	});
	return c.body(null, 204);
});

app.put("/upload/:id/artifacts/:name", async (c) => {
	const runId = c.req.param("id");
	if (!RUN_ID_PATTERN.test(runId)) return c.json({ error: "Invalid run id" }, 400);
	const name = baseName(c.req.param("name"));
	if (!name || !name.endsWith(".json")) {
		return c.json({ error: "Artifact name must be a .json basename" }, 400);
	}
	await c.env.RUNS_BUCKET.put(runKey(runId, `artifacts/${name}`), await c.req.arrayBuffer(), {
		httpMetadata: { contentType: "application/json; charset=utf-8" },
	});
	return c.body(null, 204);
});

// Finalize a report: fold the uploaded artifacts + posted metadata into run.json.
app.post("/upload/:id/complete", async (c) => {
	const runId = c.req.param("id");
	if (!RUN_ID_PATTERN.test(runId)) return c.json({ error: "Invalid run id" }, 400);
	let body: CompleteRequest;
	try {
		body = (await c.req.json()) as CompleteRequest;
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}
	if (!body.evalTarget || typeof body.evalTarget !== "string") {
		return c.json({ error: "`evalTarget` is required" }, 400);
	}
	const batchId = cleanTextField(body.batchId);
	if (batchId && !RUN_ID_PATTERN.test(batchId)) {
		return c.json({ error: "Invalid batch id" }, 400);
	}
	const kind = body.kind === "unit" || body.kind === "skill" ? body.kind : undefined;

	const artifacts: ArtifactFile[] = [];
	const listed = await c.env.RUNS_BUCKET.list({ prefix: runKey(runId, "artifacts/") });
	for (const object of listed.objects) {
		const name = object.key.slice(runKey(runId, "artifacts/").length);
		if (!name.endsWith(".json")) continue;
		const stored = await c.env.RUNS_BUCKET.get(object.key);
		let parsed: Record<string, unknown> | undefined;
		try {
			parsed = stored ? ((await stored.json()) as Record<string, unknown>) : undefined;
		} catch {
			parsed = undefined;
		}
		artifacts.push({ name, json: parsed });
	}

	const ingested = ingestResults(
		typeof body.exitCode === "number" ? body.exitCode : 1,
		artifacts,
	);
	const previousRun = await readRun(c.env, runId);
	const run: Run = {
		runId,
		status: ingested.status === "completed" ? "completed" : "failed",
		evalTarget: body.evalTarget,
		batchId,
		batchLabel: cleanTextField(body.batchLabel),
		kind,
		description: cleanTextField(body.description),
		startPrompt: ingested.startPrompt,
		ref: typeof body.ref === "string" ? body.ref : undefined,
		commit: typeof body.commit === "string" ? body.commit : undefined,
		model: typeof body.model === "string" ? body.model : undefined,
		realDeploy: typeof body.realDeploy === "boolean" ? body.realDeploy : undefined,
		startedAt: typeof body.startedAt === "string" ? body.startedAt : undefined,
		finishedAt: typeof body.finishedAt === "string" ? body.finishedAt : undefined,
		createdAt: new Date().toISOString(),
		createdBy: c.get("identity"),
		host: typeof body.host === "string" ? body.host : undefined,
		exitCode: ingested.exitCode,
		error:
			typeof body.error === "string" && body.error ? body.error : ingested.error,
		signal: ingested.signal,
		deployedApps: ingested.deployedApps,
		evaluation: ingested.evaluation,
	};
	const previousBatchId = previousRun ? batchIdForRun(previousRun) : undefined;
	const nextBatchId = batchIdForRun(run);
	const assignmentChanged = Boolean(
		previousRun && previousRun.batchId !== run.batchId,
	);
	// Reconcile the derived indexes before replacing canonical run.json. If any
	// index step fails, a retry still sees the old assignment and repeats the
	// cleanup instead of permanently orphaning the old membership.
	const nextRecentEntry = await indexBatchRun(c.env, run, !assignmentChanged);
	if (previousBatchId && previousBatchId !== nextBatchId) {
		await removeBatchRun(c.env, previousBatchId, runId);
	}
	if (previousRun && !previousRun.batchId && run.batchId) {
		await removeRecentBatch(c.env, {
			id: previousRun.runId,
			kind: "singleton",
			createdAt: previousRun.createdAt,
		});
	}
	if (assignmentChanged) await recordRecentBatch(c.env, nextRecentEntry);
	await c.env.RUNS_BUCKET.put(runKey(runId, "run.json"), JSON.stringify(run), {
		httpMetadata: { contentType: "application/json; charset=utf-8" },
	});
	return json(run, 201);
});

// ---------------------------------------------------------------------------
// Read plane: dashboard + JSON API.
// ---------------------------------------------------------------------------
app.get("/api/batches", async (c) => {
	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
	const recentEntries = await readRecentBatchIndex(c.env);
	const indexedSummaries = await resolveRecentBatchSummaries(
		c.env,
		recentEntries,
		limit,
	);
	const fallbackLimit = Math.max(limit - indexedSummaries.length, 0);
	const legacyRunIds = fallbackLimit
		? await listNewestRunIds(c.env, LEGACY_RUN_SEARCH_LIMIT)
		: [];
	const legacyRuns = await readRunsByIds(c.env, legacyRunIds);
	const legacySummaries = await summarizeLegacyRuns(c.env, legacyRuns);
	const summaries = [
		...indexedSummaries,
		...legacySummaries,
	].sort((a, b) => {
		const created = b.createdAt.localeCompare(a.createdAt);
		return created || b.id.localeCompare(a.id);
	});
	const unique = summaries.filter(
		(summary, index) =>
			summaries.findIndex((candidate) => candidate.id === summary.id) === index,
	);
	return json({ batches: unique.slice(0, limit) });
});

app.get("/api/batches/:id", async (c) => {
	const batchId = c.req.param("id");
	if (!RUN_ID_PATTERN.test(batchId)) return c.json({ error: "Invalid batch id" }, 400);
	let runs = await readBatchRuns(c.env, batchId);
	if (!runs.length) {
		const singleton = await readRun(c.env, batchId);
		if (singleton && !singleton.batchId) runs = [singleton];
		else runs = await scanCanonicalBatchRuns(c.env, batchId);
	}
	const summary = summarizeBatchRuns(batchId, runs);
	if (!summary) return c.json({ error: "Batch not found" }, 404);
	return json({ batch: summary, runs });
});

app.get("/api/runs", async (c) => {
	const batchId = c.req.query("batch");
	if (batchId) {
		if (!RUN_ID_PATTERN.test(batchId)) return c.json({ error: "Invalid batch id" }, 400);
		let runs = await readBatchRuns(c.env, batchId);
		if (!runs.length) {
			const singleton = await readRun(c.env, batchId);
			if (singleton && !singleton.batchId) runs = [singleton];
			else runs = await scanCanonicalBatchRuns(c.env, batchId);
		}
		return json({ runs });
	}

	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
	// Run ids embed a UTC timestamp (eval-YYYYMMDD-HHMMSSZ-xxxx), so reverse
	// lexicographic order over the run directories is newest-first.
	const ids = await listRunIds(c.env);
	const runs = (
		await Promise.all(ids.slice(0, limit).map((id) => readRun(c.env, id)))
	).filter((run): run is Run => run !== null);
	return json({ runs });
});

app.get("/api/runs/:id", async (c) => {
	const run = await readRun(c.env, c.req.param("id"));
	return run ? json(run) : c.json({ error: "Run not found" }, 404);
});

app.get("/api/runs/:id/log", async (c) => {
	const object = await c.env.RUNS_BUCKET.get(runKey(c.req.param("id"), "output.log"));
	if (!object) return c.text("Not found", 404);
	return new Response(object.body, {
		headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
	});
});

app.get("/api/runs/:id/artifacts", async (c) => {
	const prefix = runKey(c.req.param("id"), "artifacts/");
	const listed = await c.env.RUNS_BUCKET.list({ prefix });
	const artifacts = listed.objects
		.map((object) => object.key.slice(prefix.length))
		.filter((name) => name.endsWith(".json"))
		.sort();
	return c.json({ artifacts });
});

app.get("/api/runs/:id/artifact/:name", async (c) => {
	const object = await c.env.RUNS_BUCKET.get(
		runKey(c.req.param("id"), `artifacts/${baseName(c.req.param("name"))}`),
	);
	if (!object) return c.text("Not found", 404);
	return new Response(object.body, {
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
});

// Self-served usage doc (single source of truth for "how to run + report evals").
app.get("/skill", (c) =>
	c.text(skillDoc, 200, { "content-type": "text/markdown; charset=utf-8" }),
);

app.notFound((c) => {
	if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/upload/")) {
		return c.json({ error: "Not found" }, 404);
	}
	return c.env.ASSETS.fetch(c.req.raw);
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
