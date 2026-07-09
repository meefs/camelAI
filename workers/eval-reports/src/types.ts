/** Terminal-only: runs are reported after they finish; there is no queue. */
export type RunStatus = "completed" | "failed";
export type EvalKind = "unit" | "skill";

export interface EvalSignalSummary {
	assistantTurnCount?: number;
	toolCallCount?: number;
	badToolCallCount?: number;
	violations?: string[];
	tokenUsage?: {
		totalTokens?: number;
		inputTokens?: number;
		outputTokens?: number;
		costUsd?: number;
	};
}

export interface DeployedAppSummary {
	name: string;
	url: string;
}

/** JSON-safe value for criterion details (comes from JSON.parse'd artifacts). */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export type EvalCriterionStatus = "passed" | "failed";

export interface EvalPassFailCriterion {
	id: string;
	label: string;
	status: EvalCriterionStatus;
	reason?: string;
	details?: JsonValue;
}

export interface EvalScoreCriterion {
	id: string;
	label: string;
	points: number;
	maxPoints: number;
	reason?: string;
	details?: JsonValue;
}

export interface EvalCriteriaSummary {
	passFail: {
		passed: boolean;
		total: number;
		failed: number;
		criteria: EvalPassFailCriterion[];
	};
	scorecard: {
		points: number;
		maxPoints: number;
		percentage: number;
		criteria: EvalScoreCriterion[];
	};
}

/**
 * One finished eval run, stored as `runs/<runId>/run.json` in R2 next to its
 * `output.log` and `artifacts/<eval>.json` transcript(s).
 */
export interface Run {
	runId: string;
	status: RunStatus;
	/** The eval id that ran (e.g. "deploy-fake-data-live" or "custom-prompt-live"). */
	evalTarget: string;
	/** Shared id for all runs reported by one suite/matrix invocation. */
	batchId?: string;
	/** Human label for the batch, e.g. "suite: all" or "matrix: 2 models × 3 evals". */
	batchLabel?: string;
	/** Structural category from the eval manifest. */
	kind?: EvalKind;
	/** One-line description from the eval manifest. */
	description?: string;
	/** Initial user prompt, extracted from the transcript artifact at ingest. */
	startPrompt?: string;
	/** Branch the reporting checkout was on. */
	ref?: string;
	/** Resolved commit SHA of the reporting checkout. */
	commit?: string;
	model?: string;
	realDeploy?: boolean;
	/** When the run started/finished on the reporting machine (ISO). */
	startedAt?: string;
	finishedAt?: string;
	/** When the report was ingested (ISO); the runs list is ordered by runId (timestamped). */
	createdAt: string;
	/** Cloudflare Access identity of the reporter (email, or service-token name). */
	createdBy?: string;
	/** Hostname of the machine that ran the eval. */
	host?: string;
	exitCode?: number;
	error?: string;
	signal?: EvalSignalSummary;
	deployedApps?: DeployedAppSummary[];
	/** Real or synthesized (contract-failure) evaluation summary. */
	evaluation?: EvalCriteriaSummary;
}

export interface BatchSummary {
	/** run.batchId, or run.runId for a batchless singleton. */
	id: string;
	/** true when this is a synthesized single-run batch with no stored batchId. */
	singleton: boolean;
	label: string;
	/** Distinct eval ids contained in this batch, used for search. */
	evalTargets: string[];
	models: string[];
	ref?: string;
	commit?: string;
	passed: number;
	total: number;
	kindBreakdown: {
		unit: { passed: number; total: number };
		skill: { passed: number; total: number };
	};
	score?: { points: number; maxPoints: number; percentage: number; unscored: number };
	costUsd?: number;
	totalTokens?: number;
	badToolCalls: number;
	startedAt?: string;
	finishedAt?: string;
	/** max(run.createdAt), used for list ordering. */
	createdAt: string;
	createdBy?: string;
}

/** Body of POST /upload/:runId/complete — run metadata from the reporter. */
export interface CompleteRequest {
	evalTarget: string;
	exitCode: number;
	batchId?: string;
	batchLabel?: string;
	kind?: EvalKind;
	description?: string;
	ref?: string;
	commit?: string;
	model?: string;
	realDeploy?: boolean;
	startedAt?: string;
	finishedAt?: string;
	host?: string;
	/** Reporter-side failure context (harness crash, etc.). */
	error?: string;
}
