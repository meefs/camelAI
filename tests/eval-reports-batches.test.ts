import { describe, expect, it } from "vitest";

import {
	groupRunsIntoBatches,
	rollupByEval,
} from "../workers/eval-reports/app/lib/batches";
import type { Run } from "../workers/eval-reports/src/types";

function run(overrides: Partial<Run> & Pick<Run, "runId" | "evalTarget" | "createdAt">): Run {
	return {
		status: "failed",
		...overrides,
	};
}

function evaluation(points: number, maxPoints: number) {
	return {
		passFail: {
			passed: true,
			total: 1,
			failed: 0,
			criteria: [
				{
					id: "done",
					label: "Done",
					status: "passed" as const,
				},
			],
		},
		scorecard: {
			points,
			maxPoints,
			percentage: maxPoints > 0 ? Math.round((points / maxPoints) * 100) : 0,
			criteria: [
				{
					id: "score",
					label: "Score",
					points,
					maxPoints,
				},
			],
		},
	};
}

describe("groupRunsIntoBatches", () => {
	it("groups by batch id and keeps batchless runs as singletons", () => {
		const batches = groupRunsIntoBatches([
			run({
				runId: "eval-2",
				evalTarget: "b",
				batchId: "batch-1",
				batchLabel: "suite: smoke",
				createdAt: "2026-07-09T11:00:00Z",
			}),
			run({
				runId: "eval-1",
				evalTarget: "a",
				batchId: "batch-1",
				createdAt: "2026-07-09T10:00:00Z",
			}),
			run({
				runId: "eval-3",
				evalTarget: "legacy-eval",
				createdAt: "2026-07-09T12:00:00Z",
			}),
		]);

		expect(batches.map((batch) => batch.id)).toEqual(["eval-3", "batch-1"]);
		expect(batches[0]).toMatchObject({
			singleton: true,
			label: "legacy-eval",
			total: 1,
		});
		expect(batches[1]).toMatchObject({
			singleton: false,
			label: "suite: smoke",
			total: 2,
		});
	});

	it("aggregates score, pass count, kind buckets, activity, and unscored members", () => {
		const [batch] = groupRunsIntoBatches([
			run({
				runId: "eval-3",
				evalTarget: "unknown",
				batchId: "batch-1",
				status: "failed",
				createdAt: "2026-07-09T12:00:00Z",
				model: "sonnet",
				startedAt: "2026-07-09T10:02:00Z",
				finishedAt: "2026-07-09T10:05:00Z",
				signal: { badToolCallCount: 2 },
			}),
			run({
				runId: "eval-2",
				evalTarget: "skill-eval",
				batchId: "batch-1",
				kind: "skill",
				status: "failed",
				createdAt: "2026-07-09T11:00:00Z",
				model: "sonnet",
				startedAt: "2026-07-09T10:01:00Z",
				finishedAt: "2026-07-09T10:07:00Z",
				evaluation: evaluation(1, 4),
				signal: {
					badToolCallCount: 1,
					tokenUsage: { totalTokens: 200, costUsd: 0.25 },
				},
			}),
			run({
				runId: "eval-1",
				evalTarget: "unit-eval",
				batchId: "batch-1",
				kind: "unit",
				status: "completed",
				createdAt: "2026-07-09T10:00:00Z",
				startedAt: "2026-07-09T10:00:00Z",
				finishedAt: "2026-07-09T10:03:00Z",
				evaluation: evaluation(3, 4),
				signal: { tokenUsage: { totalTokens: 100, costUsd: 0.1 } },
			}),
		]);

		expect(batch).toMatchObject({
			passed: 1,
			total: 3,
			kindBreakdown: {
				unit: { passed: 1, total: 1 },
				skill: { passed: 0, total: 1 },
			},
			score: { points: 4, maxPoints: 8, percentage: 50, unscored: 1 },
			costUsd: 0.35,
			totalTokens: 300,
			badToolCalls: 3,
			startedAt: "2026-07-09T10:00:00Z",
			finishedAt: "2026-07-09T10:07:00Z",
		});
		expect(batch.models).toEqual(["sonnet", "default model"]);
	});

	it("omits wall-clock endpoints when every member is missing timestamps", () => {
		const [batch] = groupRunsIntoBatches([
			run({
				runId: "eval-1",
				evalTarget: "a",
				batchId: "batch-1",
				createdAt: "2026-07-09T10:00:00Z",
			}),
		]);

		expect(batch.startedAt).toBeUndefined();
		expect(batch.finishedAt).toBeUndefined();
	});

	it("keeps a batch label when the newest member has no label", () => {
		const [batch] = groupRunsIntoBatches([
			run({
				runId: "eval-2",
				evalTarget: "newer",
				batchId: "batch-1",
				createdAt: "2026-07-09T11:00:00Z",
			}),
			run({
				runId: "eval-1",
				evalTarget: "older",
				batchId: "batch-1",
				batchLabel: "suite: labeled",
				createdAt: "2026-07-09T10:00:00Z",
			}),
		]);

		expect(batch.label).toBe("suite: labeled");
	});
});

describe("rollupByEval", () => {
	it("rolls up recent statuses oldest-to-newest and sorts worst pass rate first", () => {
		const runs = [
			run({
				runId: "r6",
				evalTarget: "stable",
				status: "completed",
				createdAt: "2026-07-09T12:00:00Z",
				evaluation: evaluation(5, 5),
			}),
			run({
				runId: "r5",
				evalTarget: "flaky",
				status: "completed",
				createdAt: "2026-07-09T11:00:00Z",
				kind: "skill",
				description: "Latest description",
				startPrompt: "Prompt",
				evaluation: evaluation(3, 5),
			}),
			run({
				runId: "r4",
				evalTarget: "flaky",
				status: "failed",
				createdAt: "2026-07-09T10:00:00Z",
				evaluation: evaluation(2, 5),
			}),
			run({
				runId: "r3",
				evalTarget: "flaky",
				status: "failed",
				createdAt: "2026-07-09T09:00:00Z",
				evaluation: evaluation(1, 5),
			}),
			run({
				runId: "r2",
				evalTarget: "flaky",
				status: "completed",
				createdAt: "2026-07-09T08:00:00Z",
				evaluation: evaluation(5, 5),
			}),
			run({
				runId: "r1",
				evalTarget: "flaky",
				status: "failed",
				createdAt: "2026-07-09T07:00:00Z",
				evaluation: evaluation(0, 5),
			}),
			run({
				runId: "r0",
				evalTarget: "flaky",
				status: "completed",
				createdAt: "2026-07-09T06:00:00Z",
				evaluation: evaluation(5, 5),
			}),
		];

		const rollups = rollupByEval(runs);
		expect(rollups.map((rollup) => rollup.evalTarget)).toEqual(["flaky", "stable"]);
		expect(rollups[0]).toMatchObject({
			kind: "skill",
			description: "Latest description",
			startPrompt: "Prompt",
			runs: 6,
			passed: 3,
			avgScorePct: 53,
			recent: ["failed", "completed", "failed", "failed", "completed"],
			lastRun: { runId: "r5" },
		});
	});

	it("resolves rollup metadata fields independently", () => {
		const [rollup] = rollupByEval([
			run({
				runId: "new",
				evalTarget: "metadata-eval",
				createdAt: "2026-07-09T12:00:00Z",
				kind: "skill",
				description: "Newest description",
			}),
			run({
				runId: "old",
				evalTarget: "metadata-eval",
				createdAt: "2026-07-09T10:00:00Z",
				startPrompt: "Older captured prompt",
			}),
		]);

		expect(rollup).toMatchObject({
			kind: "skill",
			description: "Newest description",
			startPrompt: "Older captured prompt",
		});
	});
});
