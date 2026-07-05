/** Terminal-only: runs are reported after they finish; there is no queue. */
export type RunStatus = "completed" | "failed";

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

/** Body of POST /upload/:runId/complete — run metadata from the reporter. */
export interface CompleteRequest {
	evalTarget: string;
	exitCode: number;
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
