import { describe, expect, it } from "vitest";

interface TestRun {
	runId: string;
	status: "completed" | "failed";
	evalTarget: string;
	createdAt: string;
	batchId?: string;
	batchLabel?: string;
}

interface TestBatchSummary {
	id: string;
	singleton: boolean;
	label: string;
	evalTargets: string[];
	models: string[];
	passed: number;
	total: number;
	kindBreakdown: {
		unit: { passed: number; total: number };
		skill: { passed: number; total: number };
	};
	badToolCalls: number;
	createdAt: string;
}

interface TestRecentBatchEntry {
	id: string;
	kind: "batch" | "singleton";
	createdAt: string;
	revision?: number;
}

interface FakePutOptions {
	onlyIf?:
		| {
				etagMatches?: string;
				etagDoesNotMatch?: string;
			}
		| Headers;
}

async function loadWorker() {
	const modulePath = "../workers/eval-reports/src/index";
	return (await import(modulePath)) as {
		default: {
			fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response>;
		};
	};
}

function run(runId: string, overrides: Partial<TestRun> = {}): TestRun {
	return {
		runId,
		status: "completed",
		evalTarget: "eval-target",
		createdAt: "2026-07-09T00:00:00Z",
		...overrides,
	};
}

function timestampedRunId(date: Date, suffix: string): string {
	const stamp = date
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z")
		.replace("T", "-");
	return `eval-${stamp}-${suffix}`;
}

function fakeEnv({
	runs,
	batchRuns,
	batchSummaries,
	recentBatchEntries,
	conditionalSummaryPutFailures = 0,
	hideKeysUntilSummaryPutRetry = [],
	competingSummaryBeforeFirstConditionalPut,
	competingBatchRunBeforeFirstConditionalPut,
	failDeleteOnceForKey,
}: {
	runs: TestRun[];
	batchRuns?: Record<string, TestRun[]>;
	batchSummaries?: Record<string, TestBatchSummary>;
	recentBatchEntries?: TestRecentBatchEntry[];
	conditionalSummaryPutFailures?: number;
	hideKeysUntilSummaryPutRetry?: string[];
	competingSummaryBeforeFirstConditionalPut?: TestBatchSummary;
	competingBatchRunBeforeFirstConditionalPut?: {
		batchId: string;
		run: TestRun;
	};
	failDeleteOnceForKey?: string;
}) {
	const records = new Map<string, unknown>();
	const etags = new Map<string, string>();
	let etagSequence = 0;
	let summaryPutFailuresRemaining = conditionalSummaryPutFailures;
	let conditionalSummaryPutAttempts = 0;
	let competingSummaryWritten = false;
	let competingBatchRunWritten = false;
	let deleteFailureRemaining = failDeleteOnceForKey ? 1 : 0;
	const hiddenUntilRetry = new Set(hideKeysUntilSummaryPutRetry);
	function setRecord(key: string, value: unknown) {
		records.set(key, value);
		etags.set(key, `etag-${++etagSequence}`);
	}
	for (const record of runs) setRecord(`runs/${record.runId}/run.json`, record);
	for (const [batchId, members] of Object.entries(batchRuns ?? {})) {
		for (const member of members) {
			setRecord(`batch-runs/${batchId}/${member.runId}.json`, member);
		}
	}
	for (const [batchId, summary] of Object.entries(batchSummaries ?? {})) {
		setRecord(`batch-summaries/${batchId}.json`, summary);
	}
	if (recentBatchEntries) {
		setRecord("batch-index/recent.json", { entries: recentBatchEntries });
	}
	const getKeys: string[] = [];
	const listCalls: Array<{
		prefix?: string;
		delimiter?: string;
		limit?: number;
		cursor?: string;
		startAfter?: string;
	}> = [];
	const deleteKeys: string[] = [];
	function objectKeys(prefix: string): string[] {
		return [...records.keys()]
			.filter((key) => key.startsWith(prefix))
			.filter(
				(key) =>
					conditionalSummaryPutAttempts > 0 || !hiddenUntilRetry.has(key),
			)
			.sort();
	}
	function runPrefixes(): string[] {
		return objectKeys("runs/")
			.filter((key) => key.endsWith("/run.json"))
			.map((key) => key.slice(0, -"run.json".length))
			.sort();
	}
	function page<T>(items: T[], limit?: number, cursor?: string) {
		const start = Number(cursor ?? 0);
		const end = Math.min(start + (limit ?? items.length), items.length);
		return {
			items: items.slice(start, end),
			truncated: end < items.length,
			cursor: end < items.length ? String(end) : undefined,
		};
	}
	function storedValue(value: string | ArrayBuffer): unknown {
		if (typeof value !== "string") return value;
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	function headersConditionAllows(key: string, condition: Headers): boolean {
		const currentEtag = etags.get(key);
		const ifMatch = condition.get("If-Match");
		if (ifMatch && ifMatch !== currentEtag) return false;
		const ifNoneMatch = condition.get("If-None-Match");
		if (!ifNoneMatch) return true;
		if (ifNoneMatch === "*") return currentEtag === undefined;
		return currentEtag !== ifNoneMatch;
	}
	function conditionAllows(key: string, options?: FakePutOptions): boolean {
		const condition = options?.onlyIf;
		if (!condition) return true;
		if (typeof (condition as Headers).get === "function") {
			return headersConditionAllows(key, condition as Headers);
		}
		const r2Condition = condition as {
			etagMatches?: string;
			etagDoesNotMatch?: string;
		};
		const currentEtag = etags.get(key);
		if (
			r2Condition.etagMatches !== undefined &&
			currentEtag !== r2Condition.etagMatches
		) {
			return false;
		}
		if (r2Condition.etagDoesNotMatch !== undefined) {
			if (currentEtag === r2Condition.etagDoesNotMatch) return false;
		}
		return true;
	}
	return {
		env: {
			CF_ACCESS_ENABLED: "0",
			RUNS_BUCKET: {
				async list({
					prefix,
					delimiter,
					limit,
					cursor,
					startAfter,
				}: {
					prefix?: string;
					delimiter?: string;
					limit?: number;
					cursor?: string;
					startAfter?: string;
				} = {}) {
					listCalls.push({ prefix, delimiter, limit, cursor, startAfter });
					if (prefix === "runs/" && delimiter === "/") {
						const prefixes = runPrefixes().filter(
							(candidate) => !startAfter || candidate > startAfter,
						);
						const result = page(prefixes, limit, cursor);
						return {
							objects: [],
							delimitedPrefixes: result.items,
							truncated: result.truncated,
							cursor: result.cursor,
						};
					}
					const keys = objectKeys(prefix ?? "").filter(
						(candidate) => !startAfter || candidate > startAfter,
					);
					const result = page(keys, limit, cursor);
					return {
						objects: result.items.map((key) => ({ key })),
						delimitedPrefixes: [],
						truncated: result.truncated,
						cursor: result.cursor,
					};
				},
				async get(key: string) {
					getKeys.push(key);
					const record = records.get(key);
					return record
						? {
								key,
								etag: etags.get(key),
								async json() {
									return record;
								},
							}
						: null;
				},
				async put(key: string, value: string | ArrayBuffer, options?: FakePutOptions) {
					if (
						key.startsWith("batch-summaries/") &&
						options?.onlyIf
					) {
						if (
							competingSummaryBeforeFirstConditionalPut &&
							!competingSummaryWritten
						) {
							setRecord(key, competingSummaryBeforeFirstConditionalPut);
							competingSummaryWritten = true;
						}
						if (
							competingBatchRunBeforeFirstConditionalPut &&
							!competingBatchRunWritten &&
							key ===
								`batch-summaries/${competingBatchRunBeforeFirstConditionalPut.batchId}.json`
						) {
							const competing = competingBatchRunBeforeFirstConditionalPut;
							setRecord(
								`batch-runs/${competing.batchId}/${competing.run.runId}.json`,
								competing.run,
							);
							setRecord(key, summary(competing.batchId, [competing.run]));
							competingBatchRunWritten = true;
						}
						conditionalSummaryPutAttempts += 1;
						if (summaryPutFailuresRemaining > 0) {
							summaryPutFailuresRemaining -= 1;
							return null;
						}
					}
					if (!conditionAllows(key, options)) return null;
					setRecord(key, storedValue(value));
					return { key, etag: etags.get(key) };
				},
				async delete(key: string) {
					deleteKeys.push(key);
					if (key === failDeleteOnceForKey && deleteFailureRemaining > 0) {
						deleteFailureRemaining -= 1;
						throw new Error("Injected R2 delete failure");
					}
					records.delete(key);
					etags.delete(key);
				},
			},
		} as unknown,
		getKeys,
		listCalls,
		deleteKeys,
		keys: () => [...records.keys()].sort(),
		record: (key: string) => records.get(key),
	};
}

function summary(batchId: string, runs: TestRun[]): TestBatchSummary {
	return {
		id: batchId,
		singleton: false,
		label: runs.find((record) => record.batchLabel)?.batchLabel ?? `${runs.length} runs`,
		evalTargets: [...new Set(runs.map((record) => record.evalTarget))].sort(),
		models: ["default model"],
		passed: runs.filter((record) => record.status === "completed").length,
		total: runs.length,
		kindBreakdown: {
			unit: { passed: 0, total: 0 },
			skill: { passed: 0, total: 0 },
		},
		badToolCalls: 0,
		createdAt: runs.map((record) => record.createdAt).sort().at(-1) ?? "",
	};
}

function recentBatchEntry(
	id: string,
	createdAt: string,
	kind: "batch" | "singleton" = "batch",
): TestRecentBatchEntry {
	return { id, kind, createdAt };
}

describe("eval reports API", () => {
	it("returns indexed batch summaries instead of grouping the recent run slice", async () => {
		const largeBatchRuns = Array.from({ length: 250 }, (_, index) =>
			run(`eval-20260709-12${String(index).padStart(4, "0")}Z-large-${index}`, {
				batchId: "batch-large",
				batchLabel: "matrix: large",
				evalTarget:
					index % 2 === 0 ? "notebook-deploy-live" : "warehouse-list-live",
				createdAt: `2026-07-09T12:${String(index % 60).padStart(2, "0")}:00Z`,
			}),
		);
		const { env } = fakeEnv({
			runs: largeBatchRuns,
			batchRuns: { "batch-large": largeBatchRuns },
			batchSummaries: { "batch-large": summary("batch-large", largeBatchRuns) },
			recentBatchEntries: [
				recentBatchEntry("batch-large", "2026-07-09T12:59:00Z"),
			],
		});
		const worker = (await loadWorker()).default;

		const listResponse = await worker.fetch(
			new Request("https://evals.example/api/runs?limit=200"),
			env as never,
			{} as never,
		);
		const listed = (await listResponse.json()) as { runs: TestRun[] };
		expect(listed.runs).toHaveLength(200);

		const batchesResponse = await worker.fetch(
			new Request("https://evals.example/api/batches?limit=200"),
			env as never,
			{} as never,
		);
		const batches = (await batchesResponse.json()) as {
			batches: TestBatchSummary[];
		};
		expect(batches.batches).toEqual([
			expect.objectContaining({
				id: "batch-large",
				label: "matrix: large",
				evalTargets: ["notebook-deploy-live", "warehouse-list-live"],
				passed: 250,
				total: 250,
			}),
		]);
	});

	it("uses the bounded recent index without listing all batch summaries", async () => {
		const batchSummaries: Record<string, TestBatchSummary> = {};
		const recentBatchEntries: TestRecentBatchEntry[] = [];
		for (let index = 0; index < 200; index += 1) {
			const batchId = `batch-${String(index).padStart(3, "0")}`;
			const createdAt = `2026-07-09T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`;
			batchSummaries[batchId] = summary(batchId, [
				run(`eval-${index}`, { batchId, createdAt }),
			]);
			recentBatchEntries.push(recentBatchEntry(batchId, createdAt));
		}
		const { env, getKeys, listCalls } = fakeEnv({
			runs: [],
			batchSummaries,
			recentBatchEntries,
		});
		const worker = (await loadWorker()).default;

		const response = await worker.fetch(
			new Request("https://evals.example/api/batches?limit=2"),
			env as never,
			{} as never,
		);
		const body = (await response.json()) as { batches: TestBatchSummary[] };
		expect(body.batches.map((batch) => batch.id)).toEqual([
			"batch-199",
			"batch-198",
		]);
		expect(getKeys).toEqual([
			"batch-index/recent.json",
			"batch-summaries/batch-199.json",
			"batch-summaries/batch-198.json",
		]);
		expect(
			listCalls.some(
				(call) =>
					call.prefix === "batch-summaries/" || call.prefix === "runs/",
			),
		).toBe(false);
	});

	it("keeps legacy unindexed runs visible as singleton batches", async () => {
		const legacyRuns = [
			run("eval-20260709-010000Z-legacy1", {
				evalTarget: "legacy-one",
				createdAt: "2026-07-09T01:00:00Z",
			}),
			run("eval-20260709-010001Z-legacy2", {
				evalTarget: "legacy-two",
				createdAt: "2026-07-09T01:00:01Z",
			}),
		];
		const { env } = fakeEnv({ runs: legacyRuns });
		const worker = (await loadWorker()).default;

		const batchesResponse = await worker.fetch(
			new Request("https://evals.example/api/batches?limit=200"),
			env as never,
			{} as never,
		);
		const batches = (await batchesResponse.json()) as {
			batches: TestBatchSummary[];
		};
		expect(batches.batches).toEqual([
			expect.objectContaining({
				id: "eval-20260709-010001Z-legacy2",
				label: "legacy-two",
				singleton: true,
				total: 1,
			}),
			expect.objectContaining({
				id: "eval-20260709-010000Z-legacy1",
				label: "legacy-one",
				singleton: true,
				total: 1,
			}),
		]);
	});

	it("returns the newest legacy runs even though R2 lists keys ascending", async () => {
		const baseTime = Date.parse("2026-07-08T00:00:00Z");
		const legacyRuns = Array.from({ length: 250 }, (_, index) => {
			const createdAt = new Date(baseTime + index * 60_000).toISOString();
			return run(timestampedRunId(new Date(createdAt), `legacy-${index}`), {
				evalTarget: `legacy-${index}`,
				createdAt,
			});
		});
		const { env, listCalls } = fakeEnv({ runs: legacyRuns });
		const worker = (await loadWorker()).default;

		const response = await worker.fetch(
			new Request("https://evals.example/api/batches?limit=5"),
			env as never,
			{} as never,
		);
		const body = (await response.json()) as { batches: TestBatchSummary[] };
		expect(body.batches.map((batch) => batch.label)).toEqual([
			"legacy-249",
			"legacy-248",
			"legacy-247",
			"legacy-246",
			"legacy-245",
		]);
		expect(
			listCalls.some(
				(call) => call.prefix === "runs/" && Boolean(call.startAfter),
			),
		).toBe(true);
	});

	it("does not persist singleton batch indexes for batchless reports", async () => {
		const { env, keys } = fakeEnv({ runs: [] });
		const worker = (await loadWorker()).default;

		const completeResponse = await worker.fetch(
			new Request("https://evals.example/upload/eval-20260709-020000Z-solo/complete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					evalTarget: "solo-live",
					exitCode: 1,
				}),
			}),
			env as never,
			{} as never,
		);
		expect(completeResponse.status).toBe(201);
		expect(keys()).toContain("runs/eval-20260709-020000Z-solo/run.json");
		expect(keys()).not.toContain(
			"batch-runs/eval-20260709-020000Z-solo/eval-20260709-020000Z-solo.json",
		);
		expect(keys()).not.toContain(
			"batch-summaries/eval-20260709-020000Z-solo.json",
		);
		expect(keys()).toContain("batch-index/recent.json");

		const batchesResponse = await worker.fetch(
			new Request("https://evals.example/api/batches?limit=200"),
			env as never,
			{} as never,
		);
		const batches = (await batchesResponse.json()) as {
			batches: TestBatchSummary[];
		};
		expect(batches.batches).toEqual([
			expect.objectContaining({
				id: "eval-20260709-020000Z-solo",
				label: "solo-live",
				singleton: true,
				total: 1,
			}),
		]);
	});

	it("fetches one batch without reading unrelated run records", async () => {
		const recentRuns = Array.from({ length: 200 }, (_, index) =>
			run(`eval-20260709-12${String(index).padStart(4, "0")}Z-${index}`),
		);
		const oldBatchRuns = [
			run("eval-20260708-010000Z-old1", {
				batchId: "batch-old",
				batchLabel: "suite: old",
				createdAt: "2026-07-08T01:00:00Z",
			}),
			run("eval-20260708-010001Z-old2", {
				batchId: "batch-old",
				batchLabel: "suite: old",
				createdAt: "2026-07-08T01:00:01Z",
			}),
		];
		const { env, getKeys } = fakeEnv({
			runs: [...recentRuns, ...oldBatchRuns],
			batchRuns: { "batch-old": oldBatchRuns },
			batchSummaries: { "batch-old": summary("batch-old", oldBatchRuns) },
		});
		const worker = (await loadWorker()).default;

		const batchResponse = await worker.fetch(
			new Request("https://evals.example/api/batches/batch-old"),
			env as never,
			{} as never,
		);
		const batch = (await batchResponse.json()) as {
			batch: TestBatchSummary;
			runs: TestRun[];
		};
		expect(batch.batch).toEqual(
			expect.objectContaining({ id: "batch-old", total: 2 }),
		);
		expect(batch.runs.map((batchRun) => batchRun.runId)).toEqual([
			"eval-20260708-010001Z-old2",
			"eval-20260708-010000Z-old1",
		]);
		expect(getKeys).toEqual([
			"batch-runs/batch-old/eval-20260708-010000Z-old1.json",
			"batch-runs/batch-old/eval-20260708-010001Z-old2.json",
		]);
		expect(getKeys.some((key) => key.startsWith("runs/"))).toBe(false);
	});

	it("removes stale batch index entries when a run id is reported into a new batch", async () => {
		const previousRun = run("eval-20260709-130000Z-move", {
			batchId: "batch-a",
			batchLabel: "suite: old",
			evalTarget: "notebook-deploy-live",
			createdAt: "2026-07-09T13:00:00Z",
		});
		const { env, record } = fakeEnv({
			runs: [previousRun],
			batchRuns: { "batch-a": [previousRun] },
			batchSummaries: { "batch-a": summary("batch-a", [previousRun]) },
			recentBatchEntries: [
				recentBatchEntry("batch-a", previousRun.createdAt),
			],
		});
		const worker = (await loadWorker()).default;

		const completeResponse = await worker.fetch(
			new Request("https://evals.example/upload/eval-20260709-130000Z-move/complete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					evalTarget: "warehouse-list-live",
					exitCode: 1,
					batchId: "batch-b",
					batchLabel: "suite: new",
				}),
			}),
			env as never,
			{} as never,
		);
		expect(completeResponse.status).toBe(201);

		const oldBatchResponse = await worker.fetch(
			new Request("https://evals.example/api/batches/batch-a"),
			env as never,
			{} as never,
		);
		expect(oldBatchResponse.status).toBe(404);

		const newBatchResponse = await worker.fetch(
			new Request("https://evals.example/api/batches/batch-b"),
			env as never,
			{} as never,
		);
		expect(newBatchResponse.status).toBe(200);
		const newBatch = (await newBatchResponse.json()) as {
			batch: TestBatchSummary;
			runs: TestRun[];
		};
		expect(newBatch.batch).toEqual(
			expect.objectContaining({
				id: "batch-b",
				label: "suite: new",
				evalTargets: ["warehouse-list-live"],
				total: 1,
			}),
		);
		expect(newBatch.runs).toEqual([
			expect.objectContaining({
				runId: "eval-20260709-130000Z-move",
				batchId: "batch-b",
				evalTarget: "warehouse-list-live",
			}),
		]);
		const recent = record("batch-index/recent.json") as {
			entries: TestRecentBatchEntry[];
		};
		expect(recent.entries.map((entry) => entry.id)).toEqual(["batch-b"]);
	});

	it("retries a partially failed batch reassignment from the old canonical assignment", async () => {
		const runId = "eval-20260709-133000Z-move-retry";
		const previousRun = run(runId, {
			batchId: "batch-retry-old",
			batchLabel: "suite: retry old",
			evalTarget: "notebook-deploy-live",
			createdAt: "2026-07-09T13:30:00Z",
		});
		const oldMemberKey = `batch-runs/batch-retry-old/${runId}.json`;
		const { env, keys, record } = fakeEnv({
			runs: [previousRun],
			batchRuns: { "batch-retry-old": [previousRun] },
			batchSummaries: {
				"batch-retry-old": summary("batch-retry-old", [previousRun]),
			},
			failDeleteOnceForKey: oldMemberKey,
		});
		const worker = (await loadWorker()).default;
		const request = () =>
			new Request(`https://evals.example/upload/${runId}/complete`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					evalTarget: "warehouse-list-live",
					exitCode: 1,
					batchId: "batch-retry-new",
					batchLabel: "suite: retry new",
				}),
			});

		const failedResponse = await worker.fetch(
			request(),
			env as never,
			{} as never,
		);
		expect(failedResponse.status).toBe(500);
		expect(record(`runs/${runId}/run.json`)).toEqual(previousRun);

		const retryResponse = await worker.fetch(
			request(),
			env as never,
			{} as never,
		);
		expect(retryResponse.status).toBe(201);
		expect(keys()).not.toContain(oldMemberKey);
		expect(record(`runs/${runId}/run.json`)).toEqual(
			expect.objectContaining({ batchId: "batch-retry-new" }),
		);

		const oldBatchResponse = await worker.fetch(
			new Request("https://evals.example/api/batches/batch-retry-old"),
			env as never,
			{} as never,
		);
		expect(oldBatchResponse.status).toBe(404);
	});

	it("replaces a full recent-index slot without displacing another batch", async () => {
		const movedRun = run("eval-20260709-133500Z-cap-move", {
			batchId: "batch-cap-old",
			createdAt: "2026-07-09T13:35:00Z",
		});
		const recentBatchEntries = [
			recentBatchEntry("batch-cap-old", movedRun.createdAt),
		];
		for (let index = 0; index < 199; index += 1) {
			recentBatchEntries.push(
				recentBatchEntry(
					`batch-other-${String(index).padStart(3, "0")}`,
					new Date(Date.parse("2026-07-01T00:00:00Z") + index * 60_000).toISOString(),
				),
			);
		}
		const { env, record } = fakeEnv({
			runs: [movedRun],
			batchRuns: { "batch-cap-old": [movedRun] },
			batchSummaries: {
				"batch-cap-old": summary("batch-cap-old", [movedRun]),
			},
			recentBatchEntries,
		});
		const worker = (await loadWorker()).default;

		const response = await worker.fetch(
			new Request(
				"https://evals.example/upload/eval-20260709-133500Z-cap-move/complete",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						evalTarget: "eval-target",
						exitCode: 1,
						batchId: "batch-cap-new",
					}),
				},
			),
			env as never,
			{} as never,
		);
		expect(response.status).toBe(201);
		const recent = record("batch-index/recent.json") as {
			entries: TestRecentBatchEntry[];
		};
		expect(recent.entries).toHaveLength(200);
		expect(recent.entries.map((entry) => entry.id)).not.toContain("batch-cap-old");
		expect(recent.entries.map((entry) => entry.id)).toContain("batch-cap-new");
		expect(recent.entries.map((entry) => entry.id)).toContain("batch-other-000");
	});

	it("moves an old batch pointer backward when its newest member is reassigned", async () => {
		const remainingRun = run("eval-20260709-120000Z-remaining", {
			batchId: "batch-backdate-old",
			createdAt: "2026-07-09T12:00:00Z",
		});
		const movedRun = run("eval-20260709-130000Z-moved", {
			batchId: "batch-backdate-old",
			createdAt: "2026-07-09T13:00:00Z",
		});
		const { env, record } = fakeEnv({
			runs: [remainingRun, movedRun],
			batchRuns: { "batch-backdate-old": [remainingRun, movedRun] },
			batchSummaries: {
				"batch-backdate-old": summary("batch-backdate-old", [
					remainingRun,
					movedRun,
				]),
			},
			recentBatchEntries: [
				recentBatchEntry("batch-backdate-old", movedRun.createdAt),
			],
		});
		const worker = (await loadWorker()).default;

		const response = await worker.fetch(
			new Request(
				"https://evals.example/upload/eval-20260709-130000Z-moved/complete",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						evalTarget: "eval-target",
						exitCode: 1,
						batchId: "batch-backdate-new",
					}),
				},
			),
			env as never,
			{} as never,
		);
		expect(response.status).toBe(201);
		const recent = record("batch-index/recent.json") as {
			entries: TestRecentBatchEntry[];
		};
		expect(
			recent.entries.find((entry) => entry.id === "batch-backdate-old"),
		).toEqual(
			expect.objectContaining({
				createdAt: remainingRun.createdAt,
				revision: 1,
			}),
		);
	});

	it("does not tombstone a batch summary added by a concurrent reporter", async () => {
		const previousRun = run("eval-20260709-134000Z-move", {
			batchId: "batch-empty-race",
			batchLabel: "suite: race old",
			evalTarget: "notebook-deploy-live",
			createdAt: "2026-07-09T13:40:00Z",
		});
		const concurrentRun = run("eval-20260709-134001Z-concurrent", {
			batchId: "batch-empty-race",
			batchLabel: "suite: race old",
			evalTarget: "warehouse-list-live",
			createdAt: "2026-07-09T13:40:01Z",
		});
		const { env, deleteKeys, record } = fakeEnv({
			runs: [previousRun, concurrentRun],
			batchRuns: { "batch-empty-race": [previousRun] },
			batchSummaries: {
				"batch-empty-race": summary("batch-empty-race", [previousRun]),
			},
			competingBatchRunBeforeFirstConditionalPut: {
				batchId: "batch-empty-race",
				run: concurrentRun,
			},
		});
		const worker = (await loadWorker()).default;

		const response = await worker.fetch(
			new Request(
				"https://evals.example/upload/eval-20260709-134000Z-move/complete",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						evalTarget: "notebook-deploy-live",
						exitCode: 1,
						batchId: "batch-empty-race-new",
					}),
				},
			),
			env as never,
			{} as never,
		);
		expect(response.status).toBe(201);
		expect(deleteKeys).not.toContain("batch-summaries/batch-empty-race.json");
		expect(record("batch-summaries/batch-empty-race.json")).toEqual(
			expect.objectContaining({
				id: "batch-empty-race",
				evalTargets: ["warehouse-list-live"],
				total: 1,
			}),
		);

		const batchResponse = await worker.fetch(
			new Request("https://evals.example/api/batches/batch-empty-race"),
			env as never,
			{} as never,
		);
		const batch = (await batchResponse.json()) as { runs: TestRun[] };
		expect(batch.runs.map((member) => member.runId)).toEqual([
			"eval-20260709-134001Z-concurrent",
		]);
	});

	it("retries batch summary writes when another reporter updates the same batch", async () => {
		const concurrentRun = run("eval-20260709-140001Z-concurrent", {
			batchId: "batch-race",
			batchLabel: "suite: race",
			evalTarget: "notebook-deploy-live",
			createdAt: "2026-07-09T14:00:01Z",
		});
		const { env } = fakeEnv({
			runs: [concurrentRun],
			batchRuns: { "batch-race": [concurrentRun] },
			hideKeysUntilSummaryPutRetry: [
				"batch-runs/batch-race/eval-20260709-140001Z-concurrent.json",
			],
			competingSummaryBeforeFirstConditionalPut: summary("batch-race", [
				concurrentRun,
			]),
		});
		const worker = (await loadWorker()).default;

		const completeResponse = await worker.fetch(
			new Request("https://evals.example/upload/eval-20260709-140000Z-race/complete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					evalTarget: "warehouse-list-live",
					exitCode: 1,
					batchId: "batch-race",
					batchLabel: "suite: race",
				}),
			}),
			env as never,
			{} as never,
		);
		expect(completeResponse.status).toBe(201);

		const batchesResponse = await worker.fetch(
			new Request("https://evals.example/api/batches?limit=200"),
			env as never,
			{} as never,
		);
		const batches = (await batchesResponse.json()) as {
			batches: TestBatchSummary[];
		};
		expect(batches.batches).toContainEqual(
			expect.objectContaining({
				id: "batch-race",
				evalTargets: ["notebook-deploy-live", "warehouse-list-live"],
				total: 2,
			}),
		);
		const batchResponse = await worker.fetch(
			new Request("https://evals.example/api/batches/batch-race"),
			env as never,
			{} as never,
		);
		const batch = (await batchResponse.json()) as {
			runs: TestRun[];
		};
		expect(batch.runs.map((batchRun) => batchRun.runId).sort()).toEqual([
			"eval-20260709-140000Z-race",
			"eval-20260709-140001Z-concurrent",
		]);
	});
});
