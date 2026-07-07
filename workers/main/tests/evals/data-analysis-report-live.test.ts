import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import { createOrg, createUser, type TestEnv } from "../test-helpers";
import {
  assertPassFailCriteria,
  buildEvalCriteriaSummary,
  buildNoAssistantErrorCriterion,
  buildResultEventCriterion,
  buildRuntimeEventsCriterion,
  buildSessionCompletedCriterion,
  passFailCriterion,
  scoreCriterion,
  scoreSignalEfficiency,
} from "./eval-criteria";
import { emitEvalTranscript } from "./eval-transcript";
import {
  evaluateAgentEvalSignal,
  getEvalSignalThresholds,
  type EvalSignalEnv,
} from "./eval-signal";
import {
  configureEvalModel,
  getEvalTimeoutMs,
  type EvalModelEnv,
} from "./model-config";
import {
  asRecord,
  collectRuntimeEvidence,
  legacyDeployPathEvidence,
  usedTool,
} from "./project-eval-helpers";
import { ProjectFilesystemClient } from "../../src/workspace-filesystem-do";
import type { ChatThreadDO } from "../../src/chat-thread-do";
import type {
  WorkspaceFilesystemDO,
  WorkspaceProject,
} from "../../src/workspace-filesystem-do";

type DataAnalysisReportEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
};

type NotebookInspection = {
  readSuccess: boolean;
  readError?: string;
  hasTitle: boolean;
  hasFinding: boolean;
  hasExecutedOutput: boolean;
  codeCellCount: number;
  executedOutputCount: number;
  parseError?: string;
};

const PROJECT_NAME = "quarterly-revenue-analysis";
const REPORT_TITLE = "Quarterly Revenue Signal Report";
const REQUIRED_FINDING = "North region led Q4 revenue.";

const testEnv = env as unknown as DataAnalysisReportEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;

function cellSourceText(cell: Record<string, unknown>): string {
  const source = cell.source;
  if (typeof source === "string") return source;
  if (Array.isArray(source)) return source.map((line) => String(line)).join("");
  return "";
}

async function inspectNotebook(
  project: WorkspaceProject | undefined,
): Promise<NotebookInspection> {
  if (!project) {
    return {
      readSuccess: false,
      readError: "project was not created",
      hasTitle: false,
      hasFinding: false,
      hasExecutedOutput: false,
      codeCellCount: 0,
      executedOutputCount: 0,
    };
  }
  const read = await new ProjectFilesystemClient(testEnv, project.id).readFile(
    "/analysis.ipynb",
  );
  if (!read.success) {
    return {
      readSuccess: false,
      readError: read.error ?? "failed to read analysis.ipynb",
      hasTitle: false,
      hasFinding: false,
      hasExecutedOutput: false,
      codeCellCount: 0,
      executedOutputCount: 0,
    };
  }

  try {
    const parsed = JSON.parse(read.content ?? "{}");
    const cells = Array.isArray(asRecord(parsed)?.cells)
      ? asRecord(parsed)!.cells as unknown[]
      : [];
    const cellRecords = cells.map(asRecord).filter((cell): cell is Record<string, unknown> => Boolean(cell));
    const sourceText = cellRecords.map(cellSourceText).join("\n");
    const codeCells = cellRecords.filter((cell) => cell.cell_type === "code");
    const executedOutputs = codeCells.filter((cell) =>
      typeof cell.execution_count === "number" ||
      (Array.isArray(cell.outputs) && cell.outputs.length > 0),
    );
    return {
      readSuccess: true,
      hasTitle: sourceText.includes(REPORT_TITLE),
      hasFinding: sourceText.includes(REQUIRED_FINDING),
      hasExecutedOutput: executedOutputs.length > 0,
      codeCellCount: codeCells.length,
      executedOutputCount: executedOutputs.length,
    };
  } catch (error) {
    return {
      readSuccess: true,
      hasTitle: false,
      hasFinding: false,
      hasExecutedOutput: false,
      codeCellCount: 0,
      executedOutputCount: 0,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

describe("data-analysis report agent eval", () => {
  maybeIt(
    "asks the agent to create, execute, and preview a notebook-first analysis project",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `data-analysis-eval-${suffix}@example.com`,
        "password123",
        "Data Analysis Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Data Analysis Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Data analysis report eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Data Analysis Eval",
        userEmail: `data-analysis-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: getEvalTimeoutMs(testEnv, 420_000),
        message: [
          `Create a new DO-backed project named exactly "${PROJECT_NAME}" using create_project with template "data-analysis" and a concise description.`,
          `Edit analysis.ipynb into a short report titled exactly "${REPORT_TITLE}" that analyzes hardcoded quarterly revenue data for at least three regions.`,
          `Include this exact finding in markdown: "${REQUIRED_FINDING}"`,
          "Use pandas and Altair or pandas-only outputs; the default Python stack is already installed, so do not install packages unless you truly need one.",
          "Run the notebook with run_notebook until it succeeds, then set_preview for analysis.ipynb as a project notebook preview.",
          "Do not use build_project, deploy_project, wrangler, or legacy VM shell commands for this notebook-only analysis project.",
          "Reply with the report title and the key finding once the notebook has run successfully.",
        ].join(" "),
      });

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const projects = await workspaceFs.listProjectsForMigrationReset();
      const project = projects.find((candidate) => candidate.name === PROJECT_NAME);
      const notebookInspection = await inspectNotebook(project);
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 10,
          maxBadToolCalls: 2,
        }),
      );
      const legacyFailures = legacyDeployPathEvidence(result.events);
      const runtimeAssertions = {
        usedCreateProject: usedTool(result.events, "create_project", [
          /\bPROJECTS\s*\.\s*create\s*\(/i,
        ]),
        usedDataAnalysisTemplate: JSON.stringify(result.events).includes("data-analysis"),
        usedRunNotebook: usedTool(result.events, "run_notebook"),
        usedSetPreview: usedTool(result.events, "set_preview"),
        usedBuildProject: usedTool(result.events, "build_project"),
        usedDeployProject: usedTool(result.events, "deploy_project"),
        legacyFailures,
        evidence: collectRuntimeEvidence(result.events),
      };
      const agentOutputText = JSON.stringify({
        result: result.result,
        events: result.events,
        messages: result.messages.filter((message) => message.role !== "user"),
      }).toLowerCase();
      const finalResult = result.result ?? "";
      const finalResponseMentionsReport =
        finalResult.includes(REPORT_TITLE) && finalResult.includes(REQUIRED_FINDING);

      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "project_created_do_backed",
            label: "Agent created a DO-backed analysis project",
            passed: project?.backend === "do-r2",
            reason: project
              ? `Project backend was ${project.backend ?? "vm"}`
              : `No project named ${PROJECT_NAME} was created.`,
            details: { project },
          }),
          passFailCriterion({
            id: "used_analysis_flow_tools",
            label: "Agent used the data-analysis flow tools",
            passed:
              runtimeAssertions.usedCreateProject &&
              runtimeAssertions.usedDataAnalysisTemplate &&
              runtimeAssertions.usedRunNotebook &&
              runtimeAssertions.usedSetPreview,
            reason:
              runtimeAssertions.usedCreateProject &&
              runtimeAssertions.usedDataAnalysisTemplate &&
              runtimeAssertions.usedRunNotebook &&
              runtimeAssertions.usedSetPreview
                ? undefined
                : `create_project=${runtimeAssertions.usedCreateProject}, template=data-analysis=${runtimeAssertions.usedDataAnalysisTemplate}, run_notebook=${runtimeAssertions.usedRunNotebook}, set_preview=${runtimeAssertions.usedSetPreview}`,
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "notebook_content_persisted",
            label: "Notebook report content persisted",
            passed:
              notebookInspection.readSuccess &&
              notebookInspection.hasTitle &&
              notebookInspection.hasFinding,
            reason:
              notebookInspection.readSuccess && notebookInspection.hasTitle && notebookInspection.hasFinding
                ? undefined
                : notebookInspection.readError ??
                  notebookInspection.parseError ??
                  `title=${notebookInspection.hasTitle}, finding=${notebookInspection.hasFinding}`,
            details: notebookInspection,
          }),
          passFailCriterion({
            id: "notebook_executed",
            label: "Notebook was executed and output persisted",
            passed: notebookInspection.hasExecutedOutput,
            reason: notebookInspection.hasExecutedOutput
              ? undefined
              : "analysis.ipynb had no executed code-cell outputs.",
            details: notebookInspection,
          }),
          passFailCriterion({
            id: "avoided_web_deploy_path",
            label: "Agent avoided build/deploy and legacy VM paths",
            passed:
              !runtimeAssertions.usedBuildProject &&
              !runtimeAssertions.usedDeployProject &&
              legacyFailures.length === 0,
            reason:
              !runtimeAssertions.usedBuildProject &&
              !runtimeAssertions.usedDeployProject &&
              legacyFailures.length === 0
                ? undefined
                : [
                    runtimeAssertions.usedBuildProject ? "used build_project" : "",
                    runtimeAssertions.usedDeployProject ? "used deploy_project" : "",
                    ...legacyFailures,
                  ].filter(Boolean).join("; "),
            details: runtimeAssertions,
          }),
          buildNoAssistantErrorCriterion(agentOutputText),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreCriterion({
            id: "final_response_mentions_report",
            label: "Final response mentions the report title and finding",
            points: finalResponseMentionsReport ? 1 : 0,
            maxPoints: 1,
            reason: finalResponseMentionsReport
              ? undefined
              : "Final response did not include both required strings.",
            details: { finalResult },
          }),
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 10, maxBadToolCalls: 2, points: 4 },
              { maxAssistantTurns: 14, maxBadToolCalls: 4, points: 3 },
              { maxAssistantTurns: 20, maxBadToolCalls: 8, points: 2 },
            ],
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        evaluation,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        project,
        notebookInspection,
        runtimeAssertions,
        result: result.result,
        events: result.events,
        messages: result.messages,
      });

      assertPassFailCriteria(evaluation);
    },
    480_000,
  );
});
