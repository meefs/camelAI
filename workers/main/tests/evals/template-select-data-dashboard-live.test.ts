import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import { assertPassFailCriteria } from "./eval-criteria";
import { emitEvalTranscript } from "./eval-transcript";
import { getEvalTimeoutMs } from "./model-config";
import {
  runTemplateSelectionEval,
  type TemplateSelectionEvalEnv,
} from "./template-selection-eval";

const testEnv = env as unknown as TemplateSelectionEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 120_000);

describe("data dashboard template intent selection agent eval", () => {
  maybeIt(
    "chooses the data dashboard starter for interactive metrics",
    async () => {
      const outcome = await runTemplateSelectionEval(
        testEnv,
        {
          template: "data-dashboard",
          projectPrefix: "revenue-monitor",
          title: "Revenue monitor starter selection",
          prompt:
            "It will be an interactive revenue monitor with KPI cards, time-range filters, charts, detailed tables, and export actions for business operators.",
          markerPath: "/app/routes/home.tsx",
          markerText: "Data dashboard starter",
        },
        SESSION_TIMEOUT_MS,
      );
      emitEvalTranscript(outcome.transcript);
      assertPassFailCriteria(outcome.evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
