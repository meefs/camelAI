import type { EvalCriteriaSummary } from "./eval-criteria";

// Standard transcript emitter for agent evals. Every eval ends by calling emitEvalTranscript(...);
// scripts/run-agent-eval.mjs captures the JSON between the single marker pair below and writes it
// as the run's artifact. Using one shared marker (instead of a bespoke pair per eval) is what lets
// run-agent-eval.mjs stay manifest-driven — a new eval needs no marker wiring, just this call.

export const EVAL_TRANSCRIPT_START = "EVAL_TRANSCRIPT_START ";
export const EVAL_TRANSCRIPT_END = " EVAL_TRANSCRIPT_END";

export interface EvalTranscriptPayload {
  status: unknown;
  evaluation: EvalCriteriaSummary;
  error?: unknown;
  /** EVAL_MODEL used for the run (for the dashboard's per-model view). */
  model?: unknown;
  /** Output of evaluateAgentEvalSignal (turns, tool calls, token usage, violations). */
  signal?: unknown;
  /** AgentEvalSessionResult.result — the agent's final summary text. */
  result?: unknown;
  events?: unknown;
  messages?: unknown;
  /** AgentEvalSessionResult.deployedApps, when the eval deploys. */
  deployedApps?: unknown;
  /** Eval-specific runtime assertion summary, when present. */
  runtimeAssertions?: unknown;
  /** Eval-specific project creation summary, when present. */
  projectCreation?: unknown;
  /** Eval-specific source inspection summary, when present. */
  sourceInspection?: unknown;
  /** Eval-specific source inspection candidate summaries, when present. */
  sourceInspectionCandidates?: unknown;
  /** Eval-specific file inspection summary, when present. */
  fileInspection?: unknown;
  /** Eval-specific live page smoke summary, when present. */
  livePageSmoke?: unknown;
  /** Custom eval prompt/config metadata, when present. */
  prompt?: unknown;
  requiredTranscriptSubstrings?: unknown;
}

export function emitEvalTranscript(payload: EvalTranscriptPayload): void {
  console.log(EVAL_TRANSCRIPT_START + JSON.stringify(payload) + EVAL_TRANSCRIPT_END);
}
