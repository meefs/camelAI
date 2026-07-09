import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { BatchesTable } from "../workers/eval-reports/app/components/batches-table";
import { runsLoader } from "../workers/eval-reports/app/routes/runs-list";
import type {
	BatchSummary,
	Run,
} from "../workers/eval-reports/src/types";

afterEach(() => {
	vi.restoreAllMocks();
});

function loaderArgs(url: string) {
	return {
		request: new Request(url),
	};
}

describe("eval reports list loader", () => {
	it("loads only batch summaries for the default batches view", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ batches: [{ id: "batch-1" }] }),
		);

		const result = await runsLoader(loaderArgs("https://evals.example/"));

		expect(result).toEqual({ runs: [], batches: [{ id: "batch-1" }] });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith("/api/batches?limit=200");
	});

	it.each(["runs", "evals"])("loads only runs for the %s view", async (view) => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ runs: [{ runId: "eval-1" }] }),
		);

		const result = await runsLoader(
			loaderArgs(`https://evals.example/?view=${view}`),
		);

		expect(result).toEqual({ runs: [{ runId: "eval-1" }], batches: [] });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith("/api/runs?limit=200");
	});
});

describe("batches table", () => {
	it("loads member runs whenever a closed batch is opened", async () => {
		const memberRuns: Run[] = [
			{
				runId: "eval-2",
				status: "failed",
				evalTarget: "warehouse-list-live",
				createdAt: "2026-07-09T15:01:00Z",
			},
			{
				runId: "eval-1",
				status: "completed",
				evalTarget: "dashboard-fake-data-live",
				createdAt: "2026-07-09T15:00:00Z",
			},
		];
		const batch: BatchSummary = {
			id: "batch-1",
			singleton: false,
			label: "matrix: smoke",
			evalTargets: memberRuns.map((run) => run.evalTarget),
			models: ["default model"],
			passed: 1,
			total: 2,
			kindBreakdown: {
				unit: { passed: 0, total: 0 },
				skill: { passed: 0, total: 0 },
			},
			badToolCalls: 0,
			createdAt: "2026-07-09T15:01:00Z",
		};
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ runs: memberRuns }),
		);
		const user = userEvent.setup();

		render(
			<MemoryRouter>
				<BatchesTable batches={[batch]} />
			</MemoryRouter>,
		);
		await user.click(
			screen.getByRole("button", { name: "Show evals in batch" }),
		);

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith("/api/runs?batch=batch-1");
		});
		expect(await screen.findByText("warehouse-list-live")).toBeInTheDocument();
		expect(screen.getByText("dashboard-fake-data-live")).toBeInTheDocument();
	});
});
