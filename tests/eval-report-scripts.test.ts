import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
	extractReportedRunUrls,
	matrixBatchUrl,
	retryEvalFinalize,
} from "../scripts/eval-report-utils.mjs";
import { createEvalTranscriptCapture } from "../scripts/lib/eval-transcript-capture.mjs";

describe("eval report scripts", () => {
	it("captures a stdout transcript split across chunks without including concurrent stderr", () => {
		const capture = createEvalTranscriptCapture("START ", " END");
		capture.observe(Buffer.from("noise STA"));
		capture.observe(Buffer.from('RT {"status":"com'));
		// stderr is deliberately not observed by the caller.
		const stderr = Buffer.from("warning between stdout chunks\n");
		capture.observe(Buffer.from('pleted","value":1} END trailing'));

		expect(stderr.toString()).toContain("warning between stdout chunks");
		expect(capture.complete).toBe(true);
		expect(JSON.parse(capture.captured)).toEqual({ status: "completed", value: 1 });
	});

	it("retries finalization with the same run path", async () => {
		const paths: string[] = [];
		const delays: number[] = [];
		let attempts = 0;
		const result = await retryEvalFinalize(
			async () => {
				attempts += 1;
				paths.push("/upload/eval-fixed/complete");
				if (attempts < 3) throw new Error("transient failure");
				return "reported";
			},
			{
				sleep: async (delay: number) => {
					delays.push(delay);
				},
			},
		);

		expect(result).toBe("reported");
		expect(paths).toEqual([
			"/upload/eval-fixed/complete",
			"/upload/eval-fixed/complete",
			"/upload/eval-fixed/complete",
		]);
		expect(delays).toEqual([250, 500]);
	});

	it("only constructs matrix batch URLs for real reported runs", () => {
		expect(
			matrixBatchUrl({
				batchId: "batch-1",
				dryRun: false,
				reportedRunCount: 1,
				env: { ...process.env, EVAL_REPORT: "0" },
			}),
		).toBeUndefined();
		expect(
			matrixBatchUrl({
				batchId: "batch-1",
				dryRun: true,
				reportedRunCount: 1,
				env: { ...process.env, EVAL_REPORT: "1" },
			}),
		).toBeUndefined();
		expect(
			matrixBatchUrl({
				batchId: "batch-1",
				dryRun: false,
				reportedRunCount: 0,
				env: { ...process.env, EVAL_REPORT: "1" },
			}),
		).toBeUndefined();
		expect(
			matrixBatchUrl({
				batchId: "batch-1",
				dryRun: false,
				reportedRunCount: 1,
				env: {
					...process.env,
					EVAL_REPORT: "1",
					EVAL_REPORT_BASE: "https://evals.example/",
				},
			}),
		).toBe("https://evals.example/batches/batch-1");
	});

	it("recognizes successful report URLs on default and custom report bases", () => {
		expect(
			extractReportedRunUrls(`
Reported eval run: https://evals.camelai.dev/runs/eval-one (completed)
Reported eval run: http://localhost:8789/runs/eval-two (failed)
Eval report upload failed: POST /upload/eval-three/complete failed
`),
		).toEqual([
			"https://evals.camelai.dev/runs/eval-one",
			"http://localhost:8789/runs/eval-two",
		]);
	});

	it("omits the batch URL from dry-run matrix output", () => {
		const artifactDir = mkdtempSync(path.join(tmpdir(), "eval-matrix-dry-run-"));
		try {
			const result = spawnSync(
				"bun",
				[
					"scripts/run-agent-eval-matrix.mjs",
					"--dry-run",
					"--models",
					"sonnet",
					"--evals",
					"workflow-live",
					"--artifact-dir",
					artifactDir,
				],
				{
					cwd: process.cwd(),
					encoding: "utf8",
					env: { ...process.env, EVAL_REPORT: "1" },
				},
			);
			expect(result.status).toBe(0);
			expect(result.stdout).not.toContain("[eval-matrix] batch:");
			const summary = JSON.parse(
				readFileSync(path.join(artifactDir, "matrix-summary.json"), "utf8"),
				) as { batchUrl?: string; reportedRuns?: number };
				expect(summary.batchUrl).toBeUndefined();
				expect(summary.reportedRuns).toBe(0);
		} finally {
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});
});
