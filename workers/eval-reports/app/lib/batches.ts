import { summarizeBatchRuns } from "../../src/batches";
import type { BatchSummary, EvalKind, Run, RunStatus } from "../../src/types";

export interface Batch extends BatchSummary {
	runs: Run[];
}

export interface EvalRollup {
	evalTarget: string;
	kind?: EvalKind;
	description?: string;
	startPrompt?: string;
	runs: number;
	passed: number;
	avgScorePct?: number;
	recent: RunStatus[];
	recentRuns: Run[];
	lastRun: Run;
}

function timeValue(iso?: string): number | undefined {
	if (!iso) return undefined;
	const value = new Date(iso).getTime();
	return Number.isFinite(value) ? value : undefined;
}

function runCreatedTime(run: Run): number {
	return timeValue(run.createdAt) ?? 0;
}

function passCount(runs: Run[]): number {
	return runs.filter((run) => run.status === "completed").length;
}

export function groupRunsIntoBatches(runs: Run[]): Batch[] {
	const groups = new Map<string, Run[]>();
	for (const run of runs) {
		const key = run.batchId ?? run.runId;
		const group = groups.get(key);
		if (group) group.push(run);
		else groups.set(key, [run]);
	}

	const batches = [...groups.entries()]
		.map(([id, groupRuns]) => {
			const summary = summarizeBatchRuns(id, groupRuns);
			return summary ? ({ ...summary, runs: groupRuns } satisfies Batch) : null;
		})
		.filter((batch): batch is Batch => batch !== null);

	return batches.sort((a, b) => {
		const diff = (timeValue(b.createdAt) ?? 0) - (timeValue(a.createdAt) ?? 0);
		return diff || b.id.localeCompare(a.id);
	});
}

export function rollupByEval(runs: Run[]): EvalRollup[] {
	const groups = new Map<string, Run[]>();
	for (const run of runs) {
		const group = groups.get(run.evalTarget);
		if (group) group.push(run);
		else groups.set(run.evalTarget, [run]);
	}

	const rollups = [...groups.entries()].map(([evalTarget, groupRuns]) => {
		const sorted = [...groupRuns].sort((a, b) => runCreatedTime(b) - runCreatedTime(a));
		const lastRun = sorted[0];
		const scored = sorted
			.map((run) => run.evaluation?.scorecard?.percentage)
			.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
		const recentRuns = sorted.slice(0, 5).reverse();
		return {
			evalTarget,
			kind: sorted.find((run) => run.kind)?.kind,
			description: sorted.find((run) => run.description)?.description,
			startPrompt: sorted.find((run) => run.startPrompt)?.startPrompt,
			runs: sorted.length,
			passed: passCount(sorted),
			avgScorePct: scored.length
				? Math.round(scored.reduce((total, value) => total + value, 0) / scored.length)
				: undefined,
			recent: recentRuns.map((run) => run.status),
			recentRuns,
			lastRun,
		} satisfies EvalRollup;
	});

	return rollups.sort((a, b) => {
		const passRateA = a.runs ? a.passed / a.runs : 0;
		const passRateB = b.runs ? b.passed / b.runs : 0;
		return passRateA - passRateB || b.lastRun.createdAt.localeCompare(a.lastRun.createdAt);
	});
}
