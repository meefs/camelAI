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
import type { ChatThreadDO } from "../../src/chat-thread-do";
import type { WorkspaceFilesystemDO } from "../../src/workspace-filesystem-do";

type DashboardEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  PROJECT_RUNTIME_HOST: Fetcher;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as DashboardEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const DASHBOARD_FILE_PATH = "/workspace/index.html";

function runtimeReadUrl(projectId: string, filePath: string): string {
  return `http://runtime.test/v1/projects/${encodeURIComponent(projectId)}/fs/read?path=${encodeURIComponent(filePath)}`;
}

function countHits(text: string, terms: string[]): number {
  return terms.filter((term) => text.includes(term)).length;
}

function inspectDashboardHtml(html: string): {
  hasStaticHtml: boolean;
  hasCss: boolean;
  placeholderOnly: boolean;
  metricSignals: string[];
  hasTable: boolean;
  hasChart: boolean;
  hasFakeData: boolean;
  sectionSignalCount: number;
  richnessPoints: number;
  richnessDetails: Record<string, boolean | number | string[]>;
} {
  const lower = html.toLowerCase();
  const metricTerms = [
    "revenue",
    "sales",
    "orders",
    "customers",
    "users",
    "conversion",
    "profit",
    "margin",
    "growth",
    "retention",
    "churn",
    "pipeline",
    "inventory",
    "tickets",
    "satisfaction",
  ];
  const metricSignals = metricTerms.filter((term) => lower.includes(term));
  const hasStaticHtml = /<!doctype\s+html/i.test(html) || /<html[\s>]/i.test(html);
  const hasCss = /<style[\s>]/i.test(html) || /\b(class|style)=["']/i.test(html);
  const placeholderOnly =
    html.trim().length < 500 ||
    /\b(todo|lorem ipsum|placeholder|coming soon)\b/i.test(html);
  const hasTable =
    /<table[\s>]/i.test(html) ||
    /\b(table|thead|tbody|tr|row|column)\b/i.test(lower);
  const hasChart =
    /<canvas[\s>]|<svg[\s>]/i.test(html) ||
    /\b(chart|graph|bar|line|sparkline|axis|legend|visualization)\b/i.test(lower);
  const hasFakeData =
    /\b(fake|sample|mock|demo|acme|globex|initech|northwind|quarter|region|product|customer)\b/i
      .test(lower) ||
    /\$[0-9][0-9,]+/.test(html) ||
    /[0-9]+%/.test(html);
  const sectionSignalCount = countHits(lower, [
    "metric",
    "card",
    "panel",
    "section",
    "grid",
    "table",
    "chart",
    "activity",
    "sales",
    "operations",
  ]);
  const richnessDetails = {
    structuredLayout: /\b(card|metric|panel|grid|section|header)\b/i.test(lower),
    polishedCss:
      /\b(box-shadow|border-radius|gap|padding|background|--[a-z0-9-]+|font-weight|letter-spacing)\b/i
        .test(lower),
    multipleSections: sectionSignalCount >= 2,
    chartQuality:
      hasChart &&
      (/<canvas[\s>]|<svg[\s>]/i.test(html) ||
        /\b(legend|axis|bar|line|data-label|sparkline)\b/i.test(lower)),
    tableDetail:
      hasTable &&
      ((html.match(/<tr[\s>]/gi)?.length ?? 0) >= 4 ||
        (html.match(/\b(row|record|customer|order|product|region)\b/gi)?.length ?? 0) >= 6),
    responsiveStyling:
      /@media|minmax|auto-fit|auto-fill|width:\s*\d+%|clamp\(|display:\s*(grid|flex)/i
        .test(html),
  };
  const richnessPoints =
    (richnessDetails.structuredLayout ? 1 : 0) +
    (richnessDetails.polishedCss ? 1 : 0) +
    (richnessDetails.multipleSections ? 1 : 0) +
    (richnessDetails.chartQuality ? 1 : 0) +
    (richnessDetails.tableDetail ? 1 : 0) +
    (richnessDetails.responsiveStyling ? 1 : 0);
  return {
    hasStaticHtml,
    hasCss,
    placeholderOnly,
    metricSignals,
    hasTable,
    hasChart,
    hasFakeData,
    sectionSignalCount,
    richnessPoints,
    richnessDetails,
  };
}

describe("dashboard fake data agent eval", () => {
  maybeIt(
    "asks the agent to build a dashboard from fake data and prints the transcript",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `dashboard-eval-${suffix}@example.com`,
        "password123",
        "Dashboard Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Dashboard Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Dashboard fake data eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const project = await workspaceFs.createProject({
        id: "dashboard-app",
        name: "dashboard-app",
        description: "Dashboard eval project.",
        workspaceId: defaultWorkspaceId,
      });

      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Dashboard Eval",
        userEmail: `dashboard-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: getEvalTimeoutMs(testEnv, 240_000),
        message: [
          "In the dashboard-app project, create a polished static HTML dashboard using fake business data.",
          "Include at least three metric cards, a simple table, and a small chart or chart-like visualization.",
          "Write the dashboard to /workspace/index.html.",
          "Use only HTML, CSS, and vanilla JavaScript so the file can be opened directly.",
          "After creating it, verify the file exists and briefly summarize what you built.",
        ].join(" "),
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 6,
          maxBadToolCalls: 0,
        }),
      );
      const readResponse = await testEnv.PROJECT_RUNTIME_HOST.fetch(
        runtimeReadUrl(project.id, DASHBOARD_FILE_PATH),
      );
      const html = readResponse.ok ? await readResponse.text() : "";
      const inspection = inspectDashboardHtml(html);
      const assistantOutputText = JSON.stringify({
        result: result.result,
        events: result.events,
        messages: result.messages.filter((message) => message.role !== "user"),
      }).toLowerCase();
      const verifiedOrSummarized =
        /\b(verified|confirm(?:ed)?|file exists|successfully wrote|built|created|summar)/i
          .test(`${result.result ?? ""}\n${assistantOutputText}`);
      const usedDashboardProject =
        assistantOutputText.includes("dashboard-app") ||
        assistantOutputText.includes(DASHBOARD_FILE_PATH);
      const contentPassed =
        inspection.metricSignals.length >= 3 &&
        inspection.hasTable &&
        inspection.hasChart &&
        inspection.hasFakeData;
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "used_dashboard_project",
            label: "Agent used the dashboard project",
            passed: usedDashboardProject,
            reason: usedDashboardProject
              ? undefined
              : "Assistant/events output did not reference dashboard-app or /workspace/index.html.",
          }),
          passFailCriterion({
            id: "wrote_index_html",
            label: "Agent wrote /workspace/index.html",
            passed: readResponse.ok,
            reason: readResponse.ok
              ? undefined
              : `Reading ${DASHBOARD_FILE_PATH} returned HTTP ${readResponse.status}.`,
            details: { status: readResponse.status },
          }),
          passFailCriterion({
            id: "valid_static_html",
            label: "Generated file is valid static HTML",
            passed:
              inspection.hasStaticHtml &&
              inspection.hasCss &&
              !inspection.placeholderOnly,
            reason:
              inspection.hasStaticHtml &&
              inspection.hasCss &&
              !inspection.placeholderOnly
                ? undefined
                : "Generated file is missing an HTML document marker, CSS/style evidence, or enough non-placeholder content.",
            details: inspection,
          }),
          passFailCriterion({
            id: "required_dashboard_content",
            label: "Dashboard includes required product content",
            passed: contentPassed,
            reason: contentPassed
              ? undefined
              : "Dashboard did not include at least three metric signals, table evidence, chart evidence, and fake business data.",
            details: inspection,
          }),
          passFailCriterion({
            id: "verified_or_summarized_file",
            label: "Agent verified or summarized the file",
            passed: verifiedOrSummarized,
            reason: verifiedOrSummarized
              ? undefined
              : "Transcript/result did not show verification or a final summary.",
          }),
          buildNoAssistantErrorCriterion(assistantOutputText),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreCriterion({
            id: "dashboard_richness",
            label: "Dashboard richness",
            points: inspection.richnessPoints,
            maxPoints: 6,
            reason: `${inspection.richnessPoints}/6 static HTML richness heuristics passed.`,
            details: inspection.richnessDetails,
          }),
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 6, maxBadToolCalls: 0, points: 4 },
              { maxAssistantTurns: 10, maxBadToolCalls: 1, points: 3 },
              { maxAssistantTurns: 16, maxBadToolCalls: 3, points: 2 },
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
        result: result.result,
        events: result.events,
        messages: result.messages,
        fileInspection: {
          path: DASHBOARD_FILE_PATH,
          readStatus: readResponse.status,
          size: html.length,
          dashboard: inspection,
        },
      });

      assertPassFailCriteria(evaluation);
    },
    300_000,
  );
});
