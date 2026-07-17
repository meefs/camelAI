import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import type { ChatThreadDO } from "../../src/chat-thread-do";
import {
  ProjectFilesystemClient,
  type WorkspaceFilesystemDO,
} from "../../src/workspace-filesystem-do";
import { createOrg, createUser, type TestEnv } from "../test-helpers";
import {
  assertPassFailCriteria,
  buildEvalCriteriaSummary,
  buildNoAssistantErrorCriterion,
  buildResultEventCriterion,
  buildRuntimeEventsCriterion,
  buildSessionCompletedCriterion,
  passFailCriterion,
  scoreSignalEfficiency,
} from "./eval-criteria";
import { emitEvalTranscript } from "./eval-transcript";
import {
  evaluateAgentEvalSignal,
  getEvalSignalThresholds,
  type EvalSignalEnv,
} from "./eval-signal";
import { getEvalTimeoutMs, type EvalModelEnv } from "./model-config";
import {
  capabilityChildUsedTools,
  toolCallReferences,
  usedTool,
} from "./project-eval-helpers";

type OracleProjectEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as OracleProjectEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 360_000);
const CAMEL_CODE_MODEL = "deepseek-v4-auto";
const PRODUCT_MARKER = "Moonshot Mission Control";
const KICKOFF_MARKER = "ORACLE_AMBITIOUS_KICKOFF";

describe("camelCode Oracle ambitious-project agent eval", () => {
  maybeIt(
    "delegates an ambitious project start for Oracle to create directly",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const projectName = `oracle-moonshot-${suffix}`;
      const email = `oracle-project-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Oracle Project Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Oracle Project Eval ${suffix}`,
        userId,
        { billingPlan: "free" },
      );
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Oracle ambitious project eval",
        userId,
        undefined,
        CAMEL_CODE_MODEL,
      );
      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Oracle Project Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          "Delegate this ambitious project start to Oracle exactly once; do not create or edit the project yourself.",
          `Ask Oracle to create a new React Router project named exactly "${projectName}" with a concise mission-control description.`,
          `Oracle must establish a concrete foundation by making the home route visibly contain "${PRODUCT_MARKER}" and by creating /ORACLE_KICKOFF.md containing the marker ${KICKOFF_MARKER} plus a short three-phase roadmap.`,
          "Do not deploy. After Oracle finishes, summarize the foundation it created.",
        ].join(" "),
      });

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const project = (await workspaceFs.listProjectsForMigrationReset())
        .find((candidate) => candidate.name === projectName);
      let homeContent = "";
      let kickoffContent = "";
      let inspectionError: string | undefined;
      if (project) {
        const files = new ProjectFilesystemClient(testEnv, project.id);
        const home = await files.readFile("/app/routes/home.tsx");
        const kickoff = await files.readFile("/ORACLE_KICKOFF.md");
        homeContent = home.content ?? "";
        kickoffContent = kickoff.content ?? "";
        inspectionError = home.error ?? kickoff.error;
      } else {
        inspectionError = "Requested project was not created.";
      }

      const calledOracle = usedTool(result.events, "Oracle");
      const delegatedSpecificTask =
        toolCallReferences(result.events, "Oracle", projectName) &&
        toolCallReferences(result.events, "Oracle", KICKOFF_MARKER);
      const childToolsUsed = capabilityChildUsedTools(result.events, "Oracle");
      const oracleStartedProject = childToolsUsed.includes("create_project") &&
        (childToolsUsed.includes("edit") || childToolsUsed.includes("write"));
      const mainAgentAvoidedMutations = !usedTool(result.events, "create_project") &&
        !usedTool(result.events, "edit") &&
        !usedTool(result.events, "write");
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 5,
          maxBadToolCalls: 0,
        }),
      );
      const foundationCreated = project?.backend === "do-r2" &&
        homeContent.includes(PRODUCT_MARKER) &&
        kickoffContent.includes(KICKOFF_MARKER);
      const explicitlyLabeledPhases = /phase\s*(?:1|one)/i.test(kickoffContent) &&
        /phase\s*(?:2|two)/i.test(kickoffContent) &&
        /phase\s*(?:3|three)/i.test(kickoffContent);
      const numberedRoadmap = /(?:^|\n)\s*1\.\s+/m.test(kickoffContent) &&
        /(?:^|\n)\s*2\.\s+/m.test(kickoffContent) &&
        /(?:^|\n)\s*3\.\s+/m.test(kickoffContent);
      const roadmapStarted = /three[- ]phase roadmap/i.test(kickoffContent) &&
        (explicitlyLabeledPhases || numberedRoadmap);
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "oracle_received_ambitious_project",
            label: "Main agent delegated the ambitious project start to Oracle",
            passed: calledOracle && delegatedSpecificTask,
            reason: calledOracle && delegatedSpecificTask
              ? undefined
              : "Oracle was not called with the requested project and kickoff marker.",
          }),
          passFailCriterion({
            id: "oracle_created_project_foundation",
            label: "Oracle created a concrete DO-backed project foundation",
            passed: Boolean(foundationCreated),
            reason: foundationCreated ? undefined : inspectionError ??
              "The project, visible product marker, or kickoff artifact was missing.",
            details: { project, homeContent, kickoffContent },
          }),
          passFailCriterion({
            id: "oracle_performed_project_mutations",
            label: "Oracle—not the main agent—created and modified the project",
            passed: oracleStartedProject && mainAgentAvoidedMutations,
            reason: oracleStartedProject && mainAgentAvoidedMutations
              ? undefined
              : `Oracle child tools: ${childToolsUsed.join(", ") || "none"}.`,
            details: { childToolsUsed, mainAgentAvoidedMutations },
          }),
          passFailCriterion({
            id: "oracle_started_roadmap",
            label: "Oracle added the requested three-phase roadmap",
            passed: roadmapStarted,
            reason: roadmapStarted
              ? undefined
              : "The kickoff artifact did not contain phases one through three.",
            details: {
              kickoffContent,
              explicitlyLabeledPhases,
              numberedRoadmap,
            },
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 8,
            fallbackPoints: 2,
            tiers: [
              { maxAssistantTurns: 3, maxBadToolCalls: 0, points: 8 },
              { maxAssistantTurns: 5, maxBadToolCalls: 0, points: 6 },
              { maxAssistantTurns: 8, maxBadToolCalls: 1, points: 4 },
            ],
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        evaluation,
        error: result.error,
        model: CAMEL_CODE_MODEL,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          calledOracle,
          delegatedSpecificTask,
          childToolsUsed,
          oracleStartedProject,
          mainAgentAvoidedMutations,
          foundationCreated,
          roadmapStarted,
          explicitlyLabeledPhases,
          numberedRoadmap,
          inspectionError,
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
