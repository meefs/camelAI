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
import { ingestResults, type ArtifactFile } from "./ingest";
import type { CompleteRequest, Run } from "./types";

import dashboardHtml from "../dashboard/index.html";
import faviconSvg from "../dashboard/favicon.svg";
import skillDoc from "../SKILL.md";

const FAVICON_HEADERS = {
	"cache-control": "public, max-age=86400",
	"content-type": "image/svg+xml; charset=utf-8",
};

const RUNS_PREFIX = "runs/";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function runKey(runId: string, rel: string): string {
	return `${RUNS_PREFIX}${runId}/${rel}`;
}

/** Strip any path components from a client-supplied artifact name. */
function baseName(name: string): string {
	return name.split("/").pop() ?? "";
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
	const run: Run = {
		runId,
		status: ingested.status === "completed" ? "completed" : "failed",
		evalTarget: body.evalTarget,
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
	await c.env.RUNS_BUCKET.put(runKey(runId, "run.json"), JSON.stringify(run), {
		httpMetadata: { contentType: "application/json; charset=utf-8" },
	});
	return json(run, 201);
});

// ---------------------------------------------------------------------------
// Read plane: dashboard + JSON API.
// ---------------------------------------------------------------------------
app.get("/api/runs", async (c) => {
	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
	// Run ids embed a UTC timestamp (eval-YYYYMMDD-HHMMSSZ-xxxx), so reverse
	// lexicographic order over the run directories is newest-first.
	const ids: string[] = [];
	let cursor: string | undefined;
	do {
		const listed = await c.env.RUNS_BUCKET.list({
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

app.get("/favicon.svg", (c) => c.body(faviconSvg, 200, FAVICON_HEADERS));
app.get("/favicon.ico", (c) => c.body(faviconSvg, 200, FAVICON_HEADERS));

app.notFound((c) => {
	if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/upload/")) {
		return c.json({ error: "Not found" }, 404);
	}
	return c.html(dashboardHtml);
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
