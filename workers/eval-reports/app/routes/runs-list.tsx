import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
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
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { FlaskConical, Search, SearchX } from "lucide-react";
import { Link, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { VerdictBadge } from "../components/verdict-badge";
import { scoreClass } from "../components/score";
import { fetchRuns } from "../lib/api";
import {
	durationOf,
	failedCriteria,
	fmtCost,
	missing,
	shortPerson,
	whenText,
	whenTitle,
} from "../lib/format";
import type { Run } from "../../src/types";

const ALL_EVALS = "__all__";

export async function runsLoader() {
	return fetchRuns();
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

function BranchCell({ run }: { run: Run }) {
	if (!run.ref && !run.commit) return <span className="text-muted-foreground">{missing}</span>;
	return (
		<div className="max-w-40 truncate font-mono text-xs">
			{run.ref ? <span>{run.ref}</span> : null}
			{run.commit ? (
				<span className="ml-1 text-muted-foreground">{run.commit.slice(0, 7)}</span>
			) : null}
		</div>
	);
}

function ActivityCell({ run }: { run: Run }) {
	const signal = run.signal;
	if (!signal) return <span className="text-muted-foreground">{missing}</span>;
	const parts = [
		typeof signal.assistantTurnCount === "number"
			? `${signal.assistantTurnCount} turns`
			: "",
		typeof signal.tokenUsage?.costUsd === "number"
			? fmtCost(signal.tokenUsage.costUsd)
			: "",
	].filter(Boolean);
	const bad = signal.badToolCallCount ?? 0;
	const violations = signal.violations?.length ?? 0;
	if (!parts.length && bad === 0 && violations === 0) {
		return <span className="text-muted-foreground">{missing}</span>;
	}
	return (
		<div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
			{parts.length ? <span>{parts.join(" · ")}</span> : null}
			{bad > 0 ? <Badge variant="destructive">{bad} bad</Badge> : null}
			{violations > 0 ? (
				<Badge variant="destructive">
					{violations} violation{violations === 1 ? "" : "s"}
				</Badge>
			) : null}
		</div>
	);
}

function ResultCell({ run }: { run: Run }) {
	const failed = failedCriteria(run);
	const badge = <VerdictBadge status={run.status} />;
	if (run.status !== "failed" || failed.length === 0) return badge;
	return (
		<HoverCard openDelay={150}>
			<HoverCardTrigger asChild>
				<span className="inline-flex">{badge}</span>
			</HoverCardTrigger>
			<HoverCardContent align="start" className="w-80">
				<p className="text-xs font-medium text-destructive">
					{failed.length} failed {failed.length === 1 ? "criterion" : "criteria"}
				</p>
				<div className="mt-2 space-y-2">
					{failed.slice(0, 5).map((criterion) => (
						<div key={criterion.id} className="text-xs">
							<p className="font-medium">{criterion.label}</p>
							{criterion.reason ? (
								<p className="mt-0.5 line-clamp-2 text-muted-foreground">
									{criterion.reason}
								</p>
							) : null}
						</div>
					))}
					{failed.length > 5 ? (
						<p className="text-xs text-muted-foreground">
							+{failed.length - 5} more
						</p>
					) : null}
				</div>
			</HoverCardContent>
		</HoverCard>
	);
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
	const widths = ["w-16", "w-48", "w-10", "w-24", "w-28", "w-12", "w-16"];
	return (
		<div>
			<Skeleton className="h-6 w-28" />
			<Skeleton className="mt-2 h-4 w-80" />
			<div className="mt-6 flex flex-wrap items-center gap-2">
				<Skeleton className="h-8 w-80" />
				<Skeleton className="h-8 w-44" />
				<Skeleton className="h-8 w-44" />
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

export function RunsListPage() {
	const runs = useLoaderData<typeof runsLoader>();
	const [params, setParams] = useSearchParams();
	const navigate = useNavigate();
	const query = params.get("q") ?? "";
	const status = params.get("status") ?? "";
	const evalTarget = params.get("eval") ?? "";

	const evalOptions = Array.from(new Set(runs.map((run) => run.evalTarget))).sort();
	const normalizedQuery = query.toLowerCase();
	const filtered = runs.filter((run) => {
		if (status && run.status !== status) return false;
		if (evalTarget && run.evalTarget !== evalTarget) return false;
		if (!normalizedQuery) return true;
		return [run.ref, run.evalTarget, run.model, run.runId, run.createdBy]
			.join(" ")
			.toLowerCase()
			.includes(normalizedQuery);
	});
	const hasFilters = Boolean(query || status || evalTarget);

	function updateParam(key: string, value: string) {
		setParams((current) => setSearchParam(current, key, value), { replace: true });
	}

	function clearFilters() {
		setParams({}, { replace: true });
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
				<InputGroup className="max-w-xs">
					<InputGroupAddon>
						<Search />
					</InputGroupAddon>
					<InputGroupInput
						value={query}
						onChange={(event) => updateParam("q", event.currentTarget.value)}
						placeholder="Filter by eval, model, branch, id, or person..."
					/>
				</InputGroup>
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
				<span className="ml-auto text-sm text-muted-foreground">
					{filtered.length} run{filtered.length === 1 ? "" : "s"}
				</span>
			</div>

			<div className="mt-4 overflow-x-auto rounded-xl border">
				{filtered.length ? (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-24">Result</TableHead>
								<TableHead>Eval</TableHead>
								<TableHead className="w-24">Score</TableHead>
								<TableHead className="hidden md:table-cell">Branch</TableHead>
								<TableHead className="hidden md:table-cell">Activity</TableHead>
								<TableHead className="hidden w-24 sm:table-cell">Duration</TableHead>
								<TableHead className="w-28">Finished</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{filtered.map((run) => {
								const score = run.evaluation?.scorecard;
								const scorePct =
									score && typeof score.percentage === "number"
										? Math.round(score.percentage)
										: null;
								return (
									<TableRow
										key={run.runId}
										className="cursor-pointer"
										onClick={() => navigate(`/runs/${encodeURIComponent(run.runId)}`)}
									>
										<TableCell>
											<ResultCell run={run} />
										</TableCell>
										<TableCell>
												<Link
													to={`/runs/${encodeURIComponent(run.runId)}`}
													onClick={(event) => event.stopPropagation()}
													className="block max-w-72 truncate font-medium text-foreground hover:underline"
												>
												{run.evalTarget}
											</Link>
											<div className="text-xs text-muted-foreground">
												{run.model ?? "default model"}
											</div>
										</TableCell>
										<TableCell>
											{scorePct == null || !score ? (
												<span className="text-muted-foreground">{missing}</span>
											) : (
												<div>
													<div
														className={`font-medium tabular-nums ${scoreClass(scorePct)}`}
													>
														{scorePct}%
													</div>
													<div className="text-xs text-muted-foreground tabular-nums">
														{score.points}/{score.maxPoints}
													</div>
												</div>
											)}
										</TableCell>
										<TableCell className="hidden md:table-cell">
											<BranchCell run={run} />
										</TableCell>
										<TableCell className="hidden md:table-cell">
											<ActivityCell run={run} />
										</TableCell>
										<TableCell className="hidden text-sm text-muted-foreground tabular-nums sm:table-cell">
											{durationOf(run)}
										</TableCell>
										<TableCell>
											<div
												className="text-sm text-muted-foreground"
												title={whenTitle(run)}
											>
												{whenText(run)}
											</div>
											<div className="text-xs text-muted-foreground/70">
												{shortPerson(run.createdBy)}
											</div>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				) : (
					<EmptyState hasFilters={hasFilters} onClear={clearFilters} />
				)}
			</div>
		</div>
	);
}
