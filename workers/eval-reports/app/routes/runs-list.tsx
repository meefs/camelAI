import { Button } from "@/components/ui/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { FlaskConical, Search, SearchX } from "lucide-react";
import {
	type LoaderFunctionArgs,
	useLoaderData,
	useSearchParams,
} from "react-router";
import { BatchesTable } from "../components/batches-table";
import { EvalsRollup } from "../components/evals-rollup";
import { RunsTable } from "../components/runs-table";
import { fetchBatchSummaries, fetchRuns } from "../lib/api";
import {
	rollupByEval,
	type EvalRollup,
} from "../lib/batches";
import type { BatchSummary, Run } from "../../src/types";

const ALL_EVALS = "__all__";
const views = ["batches", "runs", "evals"] as const;
type RunsListView = (typeof views)[number];

export async function runsLoader({
	request,
}: Pick<LoaderFunctionArgs, "request">) {
	const url = new URL(request.url);
	const view = normalizeView(url.searchParams.get("view"));
	if (view === "batches") {
		return { runs: [], batches: await fetchBatchSummaries() };
	}
	return { runs: await fetchRuns(), batches: [] };
}

function normalizeView(value: string | null): RunsListView {
	return views.includes(value as RunsListView) ? (value as RunsListView) : "batches";
}

function setSearchParam(
	params: URLSearchParams,
	key: string,
	value: string,
): URLSearchParams {
	const next = new URLSearchParams(params);
	if (value) next.set(key, value);
	else next.delete(key);
	return next;
}

function EmptyState({
	hasFilters,
	onClear,
}: {
	hasFilters: boolean;
	onClear: () => void;
}) {
	if (hasFilters) {
		return (
			<div className="flex flex-col items-center py-16 text-center">
				<SearchX className="size-8 text-muted-foreground" />
				<p className="mt-3 text-sm font-medium">No matching runs</p>
				<Button type="button" variant="ghost" size="sm" onClick={onClear}>
					Clear filters
				</Button>
			</div>
		);
	}
	return (
		<div className="flex flex-col items-center py-16 text-center">
			<FlaskConical className="size-8 text-muted-foreground" />
			<p className="mt-3 text-sm font-medium">No runs reported yet</p>
			<p className="mt-1 text-sm text-muted-foreground">
				Run one locally:{" "}
				<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
					EVAL_REPORT=1 bun run test:eval &lt;id&gt;
				</code>
			</p>
			<Button variant="link" size="sm" asChild>
				<a href="/skill" target="_blank" rel="noopener">
					How to run an eval
				</a>
			</Button>
		</div>
	);
}

export function RunsListSkeleton() {
	const view =
		typeof window === "undefined"
			? "batches"
			: normalizeView(new URLSearchParams(window.location.search).get("view"));
	const widths =
		view === "batches"
			? ["w-4", "w-16", "w-48", "w-10", "w-10", "w-24", "w-16", "w-16"]
			: view === "evals"
				? ["w-64", "w-20", "w-16", "w-16", "w-16"]
				: ["w-16", "w-48", "w-10", "w-20", "w-24", "w-28", "w-12", "w-16"];
	return (
		<div>
			<Skeleton className="h-6 w-28" />
			<Skeleton className="mt-2 h-4 w-80" />
			<div className="mt-6 flex flex-wrap items-center gap-2">
				<Skeleton className="h-6 w-56" />
				<Skeleton className="h-8 w-80" />
				{view === "runs" ? (
					<>
						<Skeleton className="h-8 w-44" />
						<Skeleton className="h-8 w-44" />
						<Skeleton className="h-8 w-44" />
					</>
				) : view === "evals" ? (
					<Skeleton className="h-8 w-44" />
				) : null}
			</div>
			<div className="mt-4 overflow-x-auto rounded-xl border">
				<Table>
					<TableBody>
						{Array.from({ length: 8 }).map((_, rowIndex) => (
							<TableRow key={rowIndex}>
								{widths.map((width, index) => (
									<TableCell key={index}>
										<Skeleton className={cn("h-4", width)} />
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}

function batchMatches(batch: BatchSummary, query: string): boolean {
	if (!query) return true;
	return [
		batch.label,
		batch.models.join(" "),
		batch.ref,
		batch.commit,
		batch.createdBy,
		batch.evalTargets?.join(" "),
	]
		.join(" ")
		.toLowerCase()
		.includes(query);
}

function runMatches(run: Run, query: string): boolean {
	if (!query) return true;
	return [run.ref, run.evalTarget, run.model, run.runId, run.createdBy]
		.join(" ")
		.toLowerCase()
		.includes(query);
}

function evalMatches(rollup: EvalRollup, query: string): boolean {
	if (!query) return true;
	return [rollup.evalTarget, rollup.description, rollup.kind]
		.join(" ")
		.toLowerCase()
		.includes(query);
}

export function RunsListPage() {
	const { runs, batches } = useLoaderData<typeof runsLoader>();
	const [params, setParams] = useSearchParams();
	const query = params.get("q") ?? "";
	const status = params.get("status") ?? "";
	const evalTarget = params.get("eval") ?? "";
	const kind = params.get("kind") ?? "";
	const view = normalizeView(params.get("view"));
	const normalizedQuery = query.toLowerCase();

	const evalRollups = rollupByEval(runs);
	const evalOptions = Array.from(new Set(runs.map((run) => run.evalTarget))).sort();

	const filteredBatches = batches.filter((batch) => batchMatches(batch, normalizedQuery));
	const filteredRuns = runs.filter((run) => {
		if (status && run.status !== status) return false;
		if (evalTarget && run.evalTarget !== evalTarget) return false;
		if (kind && run.kind !== kind) return false;
		return runMatches(run, normalizedQuery);
	});
	const filteredEvals = evalRollups.filter((rollup) => {
		if (kind && rollup.kind !== kind) return false;
		return evalMatches(rollup, normalizedQuery);
	});

	const activeCount =
		view === "batches"
			? filteredBatches.length
			: view === "runs"
				? filteredRuns.length
				: filteredEvals.length;
	const activeLabel = view === "batches" ? "batch" : view === "runs" ? "run" : "eval";
	const hasFilters =
		view === "runs"
			? Boolean(query || status || evalTarget || kind)
			: view === "evals"
				? Boolean(query || kind)
				: Boolean(query);
	const searchPlaceholder =
		view === "batches"
			? "Search batches…"
			: view === "runs"
				? "Search runs…"
				: "Search evals…";

	function updateParam(key: string, value: string) {
		setParams((current) => setSearchParam(current, key, value), { replace: true });
	}

	function clearFilters() {
		const next = new URLSearchParams();
		next.set("view", view);
		setParams(next, { replace: true });
	}

	return (
		<div>
			<h1 className="text-lg font-semibold tracking-tight">Eval runs</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				Agent evals run locally and report here with{" "}
				<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
					EVAL_REPORT=1
				</code>
				.
			</p>

			<div className="mt-6 flex flex-wrap items-center gap-2">
				<ToggleGroup
					type="single"
					variant="outline"
					size="sm"
					value={view}
					onValueChange={(value) => {
						if (value) updateParam("view", value);
					}}
				>
					<ToggleGroupItem value="batches">Batches</ToggleGroupItem>
					<ToggleGroupItem value="runs">Runs</ToggleGroupItem>
					<ToggleGroupItem value="evals">Evals</ToggleGroupItem>
				</ToggleGroup>
				<InputGroup className="max-w-xs">
					<InputGroupAddon>
						<Search />
					</InputGroupAddon>
					<InputGroupInput
						value={query}
						onChange={(event) => updateParam("q", event.currentTarget.value)}
						placeholder={searchPlaceholder}
					/>
				</InputGroup>
				{view === "runs" ? (
					<>
						<ToggleGroup
							type="single"
							variant="outline"
							size="sm"
							value={status || "all"}
							onValueChange={(value) =>
								updateParam("status", value && value !== "all" ? value : "")
							}
						>
							<ToggleGroupItem value="all">All</ToggleGroupItem>
							<ToggleGroupItem value="completed">Passed</ToggleGroupItem>
							<ToggleGroupItem value="failed">Failed</ToggleGroupItem>
						</ToggleGroup>
						<ToggleGroup
							type="single"
							variant="outline"
							size="sm"
							value={kind || "all"}
							onValueChange={(value) =>
								updateParam("kind", value && value !== "all" ? value : "")
							}
						>
							<ToggleGroupItem value="all">All</ToggleGroupItem>
							<ToggleGroupItem value="unit">Unit</ToggleGroupItem>
							<ToggleGroupItem value="skill">Skill</ToggleGroupItem>
						</ToggleGroup>
						<Select
							value={evalTarget || ALL_EVALS}
							onValueChange={(value) =>
								updateParam("eval", value === ALL_EVALS ? "" : value)
							}
						>
							<SelectTrigger size="sm" className="h-8 w-44 text-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL_EVALS}>All evals</SelectItem>
								{evalOptions.map((option) => (
									<SelectItem key={option} value={option}>
										{option}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</>
				) : view === "evals" ? (
					<ToggleGroup
						type="single"
						variant="outline"
						size="sm"
						value={kind || "all"}
						onValueChange={(value) =>
							updateParam("kind", value && value !== "all" ? value : "")
						}
					>
						<ToggleGroupItem value="all">All</ToggleGroupItem>
						<ToggleGroupItem value="unit">Unit</ToggleGroupItem>
						<ToggleGroupItem value="skill">Skill</ToggleGroupItem>
					</ToggleGroup>
				) : null}
				<span className="ml-auto text-sm text-muted-foreground">
					{activeCount} {activeLabel}
					{activeCount === 1 ? "" : "s"}
				</span>
			</div>

			<div className="mt-4 overflow-x-auto rounded-xl border">
				{view === "batches" ? (
					filteredBatches.length ? (
						<BatchesTable batches={filteredBatches} />
					) : (
						<EmptyState hasFilters={hasFilters} onClear={clearFilters} />
					)
				) : view === "runs" ? (
					filteredRuns.length ? (
						<RunsTable runs={filteredRuns} showBatch />
					) : (
						<EmptyState hasFilters={hasFilters} onClear={clearFilters} />
					)
				) : filteredEvals.length ? (
					<EvalsRollup rollups={filteredEvals} />
				) : (
					<EmptyState hasFilters={hasFilters} onClear={clearFilters} />
				)}
			</div>
		</div>
	);
}
