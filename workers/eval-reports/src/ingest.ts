/**
 * Fold a finished run's transcript artifacts into the Run record patch (evaluation
 * summary, signal, deployed apps; synthesizes a contract failure when the artifact
 * carries no valid evaluation). Pure logic (no I/O) ported from the original
 * camelai-eval-runner ingest; the worker reads the artifact JSONs from R2 and hands
 * them here at report time.
 */
import type {
	DeployedAppSummary,
	EvalCriteriaSummary,
	EvalPassFailCriterion,
	EvalScoreCriterion,
	EvalSignalSummary,
	JsonValue,
	Run,
	RunStatus,
} from "./types";

export interface ArtifactFile {
	name: string;
	json: Record<string, unknown> | undefined;
}

const START_PROMPT_MAX = 4000;

function cleanPrompt(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > START_PROMPT_MAX
		? `${trimmed.slice(0, START_PROMPT_MAX)}…`
		: trimmed;
}

function textFromContentBlocks(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((block) => {
			if (!block || typeof block !== "object" || Array.isArray(block)) return "";
			const record = block as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string"
				? record.text
				: "";
		})
		.filter((part) => part.trim())
		.join("\n\n");
	return cleanPrompt(text);
}

export function extractStartPrompt(artifact: unknown): string | undefined {
	if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
		return undefined;
	}
	const record = artifact as Record<string, unknown>;
	if (typeof record.prompt === "string") {
		const prompt = cleanPrompt(record.prompt);
		if (prompt) return prompt;
	}
	if (!Array.isArray(record.messages)) return undefined;
	for (const message of record.messages) {
		if (!message || typeof message !== "object" || Array.isArray(message)) continue;
		const entry = message as Record<string, unknown>;
		if (entry.role !== "user") continue;
		if (typeof entry.content === "string") {
			const prompt = cleanPrompt(entry.content);
			if (prompt) return prompt;
			continue;
		}
		const prompt = textFromContentBlocks(entry.content);
		if (prompt) return prompt;
	}
	return undefined;
}

export function ingestResults(exitCode: number, artifacts: ArtifactFile[]): Partial<Run> {
	const patch: Partial<Run> = { exitCode };
	let finalStatus: RunStatus = exitCode === 0 ? "completed" : "failed";
	const evaluations: EvalCriteriaSummary[] = [];
	const evaluationContractFailures: string[] = [];
	for (const { name, json } of artifacts) {
		if (!json) continue;
		patch.startPrompt ??= extractStartPrompt(json);
		const evaluation = summarizeEvaluation(json.evaluation);
		if (evaluation) {
			evaluations.push(evaluation);
		} else {
			evaluationContractFailures.push(
				`${name}: No valid evaluation object was found in the eval artifact.`,
			);
		}
		if (typeof json.error === "string" && json.error) patch.error = json.error;
		const sig = summarizeSignal(json.signal);
		if (sig) patch.signal = sig;
		const apps = summarizeApps(json.deployedApps);
		if (apps) patch.deployedApps = apps;
	}
	if (evaluationContractFailures.length) {
		evaluations.push(contractFailureEvaluation(evaluationContractFailures.join(" ")));
		patch.error ??= evaluationContractFailures.join(" ");
	}
	if (evaluations.length) {
		patch.evaluation = aggregateEvaluations(evaluations);
		if (patch.evaluation.passFail.failed > 0) finalStatus = "failed";
	} else {
		patch.evaluation = contractFailureEvaluation(
			"No valid evaluation object was found in the eval artifact.",
		);
		patch.error ??= "No valid evaluation object was found in the eval artifact.";
		finalStatus = "failed";
	}
	patch.status = finalStatus;
	return patch;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function summarizeSignal(signal: unknown): EvalSignalSummary | undefined {
	if (!signal || typeof signal !== "object") return undefined;
	const s = signal as Record<string, unknown>;
	const usage = (s.tokenUsage ?? {}) as Record<string, unknown>;
	return {
		assistantTurnCount: num(s.assistantTurnCount),
		toolCallCount: num(s.toolCallCount),
		badToolCallCount: num(s.badToolCallCount),
		violations: Array.isArray(s.violations)
			? (s.violations as unknown[]).filter((v): v is string => typeof v === "string")
			: undefined,
		tokenUsage: {
			totalTokens: num(usage.totalTokens),
			inputTokens: num(usage.inputTokens),
			outputTokens: num(usage.outputTokens),
			costUsd: num(usage.costUsd),
		},
	};
}

function summarizeApps(apps: unknown): DeployedAppSummary[] | undefined {
	if (!Array.isArray(apps)) return undefined;
	const mapped = apps
		.map((app) => app as Record<string, unknown>)
		.filter((app) => typeof app.name === "string" && typeof app.url === "string")
		.map((app) => ({ name: app.name as string, url: app.url as string }));
	return mapped.length ? mapped : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function sanitizeDetails(value: unknown): JsonValue | undefined {
	if (value === undefined) return undefined;
	try {
		const text = JSON.stringify(value);
		// Values come from JSON.parse'd artifacts, so they are JSON-safe by construction.
		if (text.length <= 4000) return value as JsonValue;
		return { truncated: true, excerpt: text.slice(0, 4000) };
	} catch {
		return String(value).slice(0, 4000);
	}
}

function summarizePassFailCriterion(value: unknown): EvalPassFailCriterion | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const c = value as Record<string, unknown>;
	const id = str(c.id);
	const label = str(c.label);
	if (!id || !label || (c.status !== "passed" && c.status !== "failed")) return undefined;
	return {
		id,
		label,
		status: c.status,
		...(str(c.reason) ? { reason: str(c.reason) } : {}),
		...(c.details !== undefined ? { details: sanitizeDetails(c.details) } : {}),
	};
}

function summarizeScoreCriterion(value: unknown): EvalScoreCriterion | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const c = value as Record<string, unknown>;
	const id = str(c.id);
	const label = str(c.label);
	const points = num(c.points);
	const maxPoints = num(c.maxPoints);
	if (!id || !label || points === undefined || maxPoints === undefined) return undefined;
	if (points < 0 || maxPoints < 0 || points > maxPoints) return undefined;
	return {
		id,
		label,
		points,
		maxPoints,
		...(str(c.reason) ? { reason: str(c.reason) } : {}),
		...(c.details !== undefined ? { details: sanitizeDetails(c.details) } : {}),
	};
}

function buildSummary(
	passFailCriteria: EvalPassFailCriterion[],
	scoreCriteria: EvalScoreCriterion[],
): EvalCriteriaSummary {
	const failed = passFailCriteria.filter((criterion) => criterion.status === "failed").length;
	const points = scoreCriteria.reduce((total, criterion) => total + criterion.points, 0);
	const maxPoints = scoreCriteria.reduce((total, criterion) => total + criterion.maxPoints, 0);
	return {
		passFail: {
			passed: failed === 0,
			total: passFailCriteria.length,
			failed,
			criteria: passFailCriteria,
		},
		scorecard: {
			points,
			maxPoints,
			percentage: maxPoints > 0 ? Math.round((points / maxPoints) * 100) : 0,
			criteria: scoreCriteria,
		},
	};
}

function summarizeEvaluation(value: unknown): EvalCriteriaSummary | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const evaluation = value as Record<string, unknown>;
	const passFail = evaluation.passFail as Record<string, unknown> | undefined;
	const scorecard = evaluation.scorecard as Record<string, unknown> | undefined;
	if (!passFail || typeof passFail !== "object" || !scorecard || typeof scorecard !== "object") {
		return undefined;
	}
	if (!Array.isArray(passFail.criteria) || !Array.isArray(scorecard.criteria)) {
		return undefined;
	}
	const passFailCriteria = passFail.criteria.map(summarizePassFailCriterion);
	const scoreCriteria = scorecard.criteria.map(summarizeScoreCriterion);
	if (
		passFailCriteria.some((criterion) => criterion === undefined) ||
		scoreCriteria.some((criterion) => criterion === undefined)
	) {
		return undefined;
	}
	return buildSummary(
		passFailCriteria as EvalPassFailCriterion[],
		scoreCriteria as EvalScoreCriterion[],
	);
}

function contractFailureEvaluation(reason: string): EvalCriteriaSummary {
	return buildSummary(
		[
			{
				id: "evaluation_contract",
				label: "Eval emitted required evaluation summary",
				status: "failed",
				reason,
			},
		],
		[],
	);
}

function aggregateEvaluations(evaluations: EvalCriteriaSummary[]): EvalCriteriaSummary {
	return buildSummary(
		evaluations.flatMap((evaluation) => evaluation.passFail.criteria),
		evaluations.flatMap((evaluation) => evaluation.scorecard.criteria),
	);
}
