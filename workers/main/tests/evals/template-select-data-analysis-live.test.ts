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

describe("data analysis template intent selection agent eval", () => {
  maybeIt(
    "chooses the notebook report starter for an analytical deliverable",
    async () => {
      const outcome = await runTemplateSelectionEval(
        testEnv,
        {
          template: "data-analysis",
          projectPrefix: "retention-study",
          title: "Retention study starter selection",
          prompt:
            "The primary deliverable is a read-only analytical report: use Python to explore cohort retention, present reproducible tables and charts, and publish the finished findings as an article rather than an interactive application.",
          markerPath: "/analysis.ipynb",
          markerText: "Key Findings",
        },
        SESSION_TIMEOUT_MS,
      );
      emitEvalTranscript(outcome.transcript);
      assertPassFailCriteria(outcome.evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
