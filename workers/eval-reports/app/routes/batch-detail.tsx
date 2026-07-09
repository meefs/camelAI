import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CircleX } from "lucide-react";
import { Link, type LoaderFunctionArgs, useLoaderData } from "react-router";
import { BackButton } from "../components/back-button";
import { BatchResultBadge } from "../components/batch-result-badge";
import { RunsTable } from "../components/runs-table";
import { ScoreValue } from "../components/score";
import { fetchBatch } from "../lib/api";
import type { Batch } from "../lib/batches";
import {
	durationBetween,
	failedCriteria,
	fmtCost,
	fmtTokens,
	missing,
	relTime,
	shortPerson,
} from "../lib/format";
import { RunIdLine, SeparatorDot, StatTile } from "./run-detail";

export async function batchLoader({ params }: LoaderFunctionArgs) {
	if (!params.batchId) throw new Response("Batch not found", { status: 404 });
	const { batch, runs } = await fetchBatch(params.batchId);
	return { ...batch, runs } satisfies Batch;
}

function modelSummary(batch: Batch): string {
	return batch.models.join(", ");
}

function BatchMetaLine({ batch }: { batch: Batch }) {
	const items: React.ReactNode[] = [];
	if (batch.models.length) items.push(modelSummary(batch));
	if (batch.ref || batch.commit) {
		items.push(
			<span className="font-mono text-xs">
				{batch.ref}
				{batch.ref && batch.commit ? "@" : ""}
				{batch.commit?.slice(0, 7)}
			</span>,
		);
	}
	const duration = durationBetween(batch.startedAt, batch.finishedAt);
	if (duration !== missing) items.push(duration);
	const finishedAt = batch.finishedAt ?? batch.createdAt;
	if (finishedAt) items.push(<span title={finishedAt}>finished {relTime(finishedAt)}</span>);
	if (batch.createdBy) items.push(`by ${shortPerson(batch.createdBy)}`);

	return (
		<div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
			{items.map((item, index) => (
				<span key={index} className="inline-flex items-center gap-2">
					{index > 0 ? <SeparatorDot /> : null}
					{item}
				</span>
			))}
		</div>
	);
}

function PassedTileValue({ batch }: { batch: Batch }) {
	return (
		<>
			<span>
				{batch.passed}/{batch.total}
			</span>
			{batch.kindBreakdown.unit.total > 0 ? (
				<span className="mt-1 block text-xs font-normal text-muted-foreground">
					unit {batch.kindBreakdown.unit.passed}/{batch.kindBreakdown.unit.total}
				</span>
			) : null}
			{batch.kindBreakdown.skill.total > 0 ? (
				<span className="block text-xs font-normal text-muted-foreground">
					skill {batch.kindBreakdown.skill.passed}/{batch.kindBreakdown.skill.total}
				</span>
			) : null}
		</>
	);
}

function FailedCriteriaCard({ batch }: { batch: Batch }) {
	const failedRuns = batch.runs.filter((run) => run.status === "failed");
	if (!failedRuns.length) return null;
	return (
		<Card>
			<CardHeader className="border-b">
				<CardTitle className="flex items-center gap-2">
					Failed criteria
					<span className="text-xs font-normal text-muted-foreground">
						{failedRuns.length} run{failedRuns.length === 1 ? "" : "s"}
					</span>
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="divide-y">
					{failedRuns.map((run) => {
						const failed = failedCriteria(run);
						const visible = failed.slice(0, 5);
						return (
							<div key={run.runId} className="py-3 first:pt-0 last:pb-0">
								<Link
									to={`/runs/${encodeURIComponent(run.runId)}?tab=overview`}
									className="block truncate text-sm font-medium hover:underline"
								>
									{run.evalTarget}
								</Link>
								<div className="mt-1 space-y-1">
									{visible.length ? (
										visible.map((criterion) => (
											<div
												key={criterion.id}
												className="flex min-w-0 items-center gap-1.5 text-xs"
												title={`${criterion.label}${
													criterion.reason ? ` — ${criterion.reason}` : ""
												}`}
											>
												<CircleX className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />
												<span className="min-w-0 truncate">{criterion.label}</span>
												{criterion.reason ? (
													<span className="min-w-0 truncate text-muted-foreground">
														— {criterion.reason}
													</span>
												) : null}
											</div>
										))
									) : (
										<div className="flex min-w-0 items-center gap-1.5 text-xs">
											<CircleX className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />
											<span className="min-w-0 truncate">Run failed</span>
											{run.error ? (
												<span className="min-w-0 truncate text-muted-foreground">
													— {run.error}
												</span>
											) : null}
										</div>
									)}
									{failed.length > 5 ? (
										<p className="text-xs text-muted-foreground">
											+{failed.length - 5} more
										</p>
									) : null}
								</div>
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}

export function BatchDetailSkeleton() {
	return (
		<div>
			<Skeleton className="h-6 w-28" />
			<div className="mt-4 flex items-start justify-between gap-4">
				<div className="min-w-0 flex-1">
					<Skeleton className="h-7 w-80" />
					<Skeleton className="mt-2 h-4 w-96" />
					<Skeleton className="mt-2 h-4 w-64" />
				</div>
				<Skeleton className="h-12 w-20" />
			</div>
			<div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3 lg:grid-cols-6">
				{Array.from({ length: 6 }).map((_, index) => (
					<div key={index} className="bg-card px-4 py-3">
						<Skeleton className="h-3 w-16" />
						<Skeleton className="mt-2 h-4 w-12" />
					</div>
				))}
			</div>
			<Skeleton className="mt-4 h-40" />
		</div>
	);
}

export function BatchDetailPage() {
	const batch = useLoaderData<typeof batchLoader>();
	const score = batch.score;
	const wallTime = durationBetween(batch.startedAt, batch.finishedAt);

	return (
		<div>
			<BackButton fallback="/?view=batches" />
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-3">
						<BatchResultBadge
							passed={batch.passed}
							total={batch.total}
							size="lg"
						/>
						<h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">
							{batch.label}
						</h1>
					</div>
					<BatchMetaLine batch={batch} />
					<RunIdLine runId={batch.id} copyLabel="Copy batch id" />
				</div>
				{score ? (
					<div>
						<ScoreValue
							percentage={score.percentage}
							points={score.points}
							maxPoints={score.maxPoints}
							size="lg"
						/>
						{score.unscored > 0 ? (
							<p className="mt-1 text-right text-xs text-muted-foreground">
								⚠ {score.unscored} run{score.unscored === 1 ? "" : "s"} unscored
							</p>
						) : null}
					</div>
				) : null}
			</div>

			<div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3 lg:grid-cols-6">
				<StatTile label="Passed" value={<PassedTileValue batch={batch} />} />
				<StatTile
					label="Score"
					value={score ? `${score.percentage}%` : missing}
				>
					{score ? (
						<span className="mt-1 block text-xs font-normal text-muted-foreground">
							{score.points}/{score.maxPoints} pts
						</span>
					) : null}
				</StatTile>
				<StatTile label="Cost" value={fmtCost(batch.costUsd)} />
				<StatTile label="Tokens" value={fmtTokens(batch.totalTokens)} />
				<StatTile
					label="Bad tool calls"
					value={batch.badToolCalls}
					destructive={batch.badToolCalls > 0}
				/>
				<StatTile label="Wall time" value={wallTime} />
			</div>

			<div className="mt-4 space-y-4">
				<FailedCriteriaCard batch={batch} />
				<div>
					<h2 className="text-sm font-medium">Runs ({batch.runs.length})</h2>
					<div className="mt-2 overflow-x-auto rounded-xl border">
						<RunsTable runs={batch.runs} showBranch={false} showModel />
					</div>
				</div>
			</div>
		</div>
	);
}
