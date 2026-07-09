import type { BatchSummary, Run } from "./types";

function timeValue(iso?: string): number | undefined {
	if (!iso) return undefined;
	const value = new Date(iso).getTime();
	return Number.isFinite(value) ? value : undefined;
}

function newestIso(values: Array<string | undefined>): string | undefined {
	let best: { iso: string; time: number } | undefined;
	for (const iso of values) {
		const time = timeValue(iso);
		if (time === undefined) continue;
		if (!best || time > best.time) best = { iso: iso!, time };
	}
	return best?.iso;
}

function oldestIso(values: Array<string | undefined>): string | undefined {
	let best: { iso: string; time: number } | undefined;
	for (const iso of values) {
		const time = timeValue(iso);
		if (time === undefined) continue;
		if (!best || time < best.time) best = { iso: iso!, time };
	}
	return best?.iso;
}

function isScored(run: Run): boolean {
	const scorecard = run.evaluation?.scorecard;
	return Boolean(scorecard && scorecard.maxPoints > 0);
}

function modelLabel(run: Run): string {
	return run.model ?? "default model";
}

function passCount(runs: Run[]): number {
	return runs.filter((run) => run.status === "completed").length;
}

export function batchIdForRun(run: Run): string {
	return run.batchId ?? run.runId;
}

export function summarizeBatchRuns(id: string, runs: Run[]): BatchSummary | null {
	const first = runs[0];
	if (!first) return null;
	const singleton = runs.length === 1 && !first.batchId;
	const scoredRuns = runs.filter(isScored);
	const points = scoredRuns.reduce(
		(total, run) => total + (run.evaluation?.scorecard.points ?? 0),
		0,
	);
	const maxPoints = scoredRuns.reduce(
		(total, run) => total + (run.evaluation?.scorecard.maxPoints ?? 0),
		0,
	);
	const unscored = runs.length - scoredRuns.length;
	const kindBreakdown = {
		unit: { passed: 0, total: 0 },
		skill: { passed: 0, total: 0 },
	};
	for (const run of runs) {
		if (run.kind !== "unit" && run.kind !== "skill") continue;
		kindBreakdown[run.kind].total += 1;
		if (run.status === "completed") kindBreakdown[run.kind].passed += 1;
	}
	const costValues = runs
		.map((run) => run.signal?.tokenUsage?.costUsd)
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	const tokenValues = runs
		.map((run) => run.signal?.tokenUsage?.totalTokens)
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	const createdAt = newestIso(runs.map((run) => run.createdAt)) ?? first.createdAt;

	return {
		id,
		singleton,
		label:
			runs.find((run) => run.batchLabel)?.batchLabel ??
			(singleton ? first.evalTarget : `${runs.length} runs`),
		evalTargets: [...new Set(runs.map((run) => run.evalTarget))].sort(),
		models: [...new Set(runs.map(modelLabel))],
		ref: runs.find((run) => run.ref)?.ref,
		commit: runs.find((run) => run.commit)?.commit,
		passed: passCount(runs),
		total: runs.length,
		kindBreakdown,
		score:
			maxPoints > 0
				? {
						points,
						maxPoints,
						percentage: Math.round((points / maxPoints) * 100),
						unscored,
					}
				: undefined,
		costUsd: costValues.length
			? costValues.reduce((total, value) => total + value, 0)
			: undefined,
		totalTokens: tokenValues.length
			? tokenValues.reduce((total, value) => total + value, 0)
			: undefined,
		badToolCalls: runs.reduce(
			(total, run) => total + (run.signal?.badToolCallCount ?? 0),
			0,
		),
		startedAt: oldestIso(runs.map((run) => run.startedAt)),
		finishedAt: newestIso(runs.map((run) => run.finishedAt)),
		createdAt,
		createdBy: runs.find((run) => run.createdBy)?.createdBy,
	};
}
