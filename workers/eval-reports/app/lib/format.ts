import type { EvalPassFailCriterion, Run } from "../../src/types";

export const missing = "—";

function timeValue(iso?: string): number | null {
	if (!iso) return null;
	const value = new Date(iso).getTime();
	return Number.isFinite(value) ? value : null;
}

export function relTime(iso?: string): string {
	const value = timeValue(iso);
	if (value == null) return missing;
	const seconds = Math.max(0, (Date.now() - value) / 1000);
	if (seconds < 60) return `${Math.floor(seconds)}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}

function fmtDurationMs(ms: number): string {
	let seconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	seconds %= 60;
	return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function durationBetween(startIso?: string, endIso?: string): string {
	const start = timeValue(startIso);
	const end = timeValue(endIso);
	return start != null && end != null ? fmtDurationMs(end - start) : missing;
}

export function durationOf(run: Run): string {
	return durationBetween(run.startedAt, run.finishedAt);
}

export function fmtCost(value?: number): string {
	return typeof value === "number" && Number.isFinite(value)
		? `$${value.toFixed(value < 1 ? 4 : 2)}`
		: missing;
}

export function fmtInt(value?: number): string {
	return typeof value === "number" && Number.isFinite(value)
		? value.toLocaleString()
		: missing;
}

const tokenFormatter = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});

export function fmtTokens(value?: number): string {
	return typeof value === "number" && Number.isFinite(value)
		? tokenFormatter.format(value)
		: missing;
}

export function stripAnsi(value: string): string {
	return String(value || "")
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\x1b\][^\x07]*\x07/g, "");
}

export function whenText(run: Run): string {
	return relTime(run.finishedAt ?? run.createdAt);
}

export function whenTitle(run: Run): string {
	return run.finishedAt ?? run.createdAt ?? "";
}

export function failedCriteria(run: Run): EvalPassFailCriterion[] {
	return (run.evaluation?.passFail?.criteria ?? []).filter(
		(criterion) => criterion?.status === "failed",
	);
}

export function contractFailureReason(run: Run): string | undefined {
	return failedCriteria(run).find((criterion) => criterion.id === "evaluation_contract")
		?.reason;
}

export function scoreParts(run: Run) {
	const scorecard = run.evaluation?.scorecard;
	if (!scorecard || typeof scorecard.percentage !== "number") return null;
	return scorecard;
}

export function shortPerson(value?: string): string {
	return value?.split("@")[0] ?? "";
}

export function safeHttpUrl(value?: string): string | null {
	return /^https?:\/\//i.test(String(value ?? "")) ? String(value) : null;
}
