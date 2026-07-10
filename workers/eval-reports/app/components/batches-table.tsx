import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ChevronRight, CircleCheck, CircleX } from "lucide-react";
import { Fragment, useState } from "react";
import { useNavigate } from "react-router";
import { BatchResultBadge } from "./batch-result-badge";
import { EvalHoverCard, EvalKindBadge, EvalTierBadge } from "./eval-name-cell";
import { scoreClass } from "./score";
import { BranchCell } from "./runs-table";
import { fetchBatchRuns } from "../lib/api";
import {
	durationBetween,
	durationOf,
	failedCriteria,
	missing,
	relTime,
	shortPerson,
} from "../lib/format";
import type { BatchSummary, Run } from "../../src/types";

function modelSummary(models: string[]): string {
	if (models.length <= 2) return models.join(", ");
	return `${models.slice(0, 2).join(", ")} +${models.length - 2}`;
}

function ScoreCell({ batch }: { batch: BatchSummary }) {
	if (!batch.score) return <span className="text-muted-foreground">{missing}</span>;
	return (
		<div>
			<div className={`font-medium tabular-nums ${scoreClass(batch.score.percentage)}`}>
				{batch.score.percentage}%
				{batch.score.unscored > 0 ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="ml-1 cursor-help text-xs text-muted-foreground">
								⚠ {batch.score.unscored}
							</span>
						</TooltipTrigger>
						<TooltipContent>
							{batch.score.unscored} run
							{batch.score.unscored === 1
								? " reported no scorecard and is"
								: "s reported no scorecard and are"}{" "}
							excluded from the points total
						</TooltipContent>
					</Tooltip>
				) : null}
			</div>
			<div className="text-xs text-muted-foreground tabular-nums">
				{batch.score.points}/{batch.score.maxPoints}
			</div>
		</div>
	);
}

function orderedPeekRuns(runs: Run[]): Run[] {
	const indexes = new Map(runs.map((run, index) => [run.runId, index]));
	return [...runs].sort((a, b) => {
		const aFailed = a.status === "failed" ? 0 : 1;
		const bFailed = b.status === "failed" ? 0 : 1;
		return aFailed - bFailed || (indexes.get(a.runId) ?? 0) - (indexes.get(b.runId) ?? 0);
	});
}

function runScorePct(run: Run): number | undefined {
	const scorecard = run.evaluation?.scorecard;
	if (!scorecard || scorecard.maxPoints <= 0) return undefined;
	return typeof scorecard.percentage === "number"
		? Math.round(scorecard.percentage)
		: undefined;
}

function failedCriterionText(run: Run): string | undefined {
	const criterion = failedCriteria(run)[0];
	if (!criterion) return undefined;
	return `${criterion.label}${criterion.reason ? ` — ${criterion.reason}` : ""}`;
}

export function BatchesTable({ batches }: { batches: BatchSummary[] }) {
	const navigate = useNavigate();
	const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
	const [peekRunsById, setPeekRunsById] = useState<Record<string, Run[]>>({});
	const [loadingIds, setLoadingIds] = useState<ReadonlySet<string>>(new Set());
	const [errorIds, setErrorIds] = useState<ReadonlySet<string>>(new Set());

	async function loadPeekRuns(batchId: string) {
		if (peekRunsById[batchId] || loadingIds.has(batchId)) return;
		setLoadingIds((current) => new Set(current).add(batchId));
		setErrorIds((current) => {
			const next = new Set(current);
			next.delete(batchId);
			return next;
		});
		try {
			const runs = await fetchBatchRuns(batchId);
			setPeekRunsById((current) => ({ ...current, [batchId]: runs }));
		} catch {
			setErrorIds((current) => new Set(current).add(batchId));
		} finally {
			setLoadingIds((current) => {
				const next = new Set(current);
				next.delete(batchId);
				return next;
			});
		}
	}

	function setBatchOpen(batchId: string, open: boolean) {
		setOpenIds((current) => {
			const next = new Set(current);
			if (open) next.add(batchId);
			else next.delete(batchId);
			return next;
		});
	}

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead className="w-8" />
					<TableHead className="w-28">Result</TableHead>
					<TableHead>Batch</TableHead>
					<TableHead className="w-24">Score</TableHead>
					<TableHead className="w-16">Evals</TableHead>
					<TableHead className="hidden md:table-cell">Branch</TableHead>
					<TableHead className="hidden w-24 sm:table-cell">Duration</TableHead>
					<TableHead className="w-28">Finished</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{batches.map((batch) => {
					const finishedAt = batch.finishedAt ?? batch.createdAt;
					const hasBothKinds =
						batch.kindBreakdown.unit.total > 0 &&
						batch.kindBreakdown.skill.total > 0;
					const isOpen = openIds.has(batch.id);
					const peekRuns = peekRunsById[batch.id];
					const isLoading = loadingIds.has(batch.id);
					const hasError = errorIds.has(batch.id);
					return (
						<Fragment key={batch.id}>
							<TableRow
								className="cursor-pointer"
								onClick={() => navigate(`/batches/${encodeURIComponent(batch.id)}`)}
							>
								<TableCell>
									{batch.total > 1 ? (
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											aria-expanded={isOpen}
											aria-label={
												isOpen ? "Hide evals in batch" : "Show evals in batch"
											}
											onClick={(event) => {
												event.stopPropagation();
												const opening = !isOpen;
												setBatchOpen(batch.id, opening);
												if (opening) void loadPeekRuns(batch.id);
											}}
										>
											<ChevronRight
												className={cn(
													"transition-transform",
													isOpen && "rotate-90",
												)}
											/>
										</Button>
									) : null}
								</TableCell>
								<TableCell>
									<BatchResultBadge passed={batch.passed} total={batch.total} />
								</TableCell>
								<TableCell>
									<div className="max-w-96 truncate font-medium">{batch.label}</div>
									<div className="max-w-96 truncate text-xs text-muted-foreground">
										{modelSummary(batch.models)}
									</div>
								</TableCell>
								<TableCell>
									<ScoreCell batch={batch} />
								</TableCell>
								<TableCell>
									<div className="tabular-nums">{batch.total}</div>
									{hasBothKinds ? (
										<div className="text-xs text-muted-foreground">
											{batch.kindBreakdown.unit.total}u ·{" "}
											{batch.kindBreakdown.skill.total}s
										</div>
									) : null}
								</TableCell>
								<TableCell className="hidden md:table-cell">
									<BranchCell refName={batch.ref} commit={batch.commit} />
								</TableCell>
								<TableCell className="hidden text-sm text-muted-foreground tabular-nums sm:table-cell">
									{durationBetween(batch.startedAt, batch.finishedAt)}
								</TableCell>
								<TableCell>
									<div className="text-sm text-muted-foreground" title={finishedAt}>
										{relTime(finishedAt)}
									</div>
									<div className="text-xs text-muted-foreground/70">
										{shortPerson(batch.createdBy)}
									</div>
								</TableCell>
							</TableRow>
							{isOpen ? (
								<TableRow className="hover:bg-transparent">
									<TableCell colSpan={8} className="bg-muted/30 p-0">
										<div className="divide-y border-t">
											{isLoading ? (
												<div className="py-2 pr-4 pl-12 text-sm text-muted-foreground">
													Loading evals...
												</div>
											) : hasError ? (
												<div className="py-2 pr-4 pl-12 text-sm text-destructive">
													Unable to load evals in this batch.
												</div>
											) : peekRuns ? (
												orderedPeekRuns(peekRuns).map((run) => {
												const scorePct = runScorePct(run);
												const failedText = failedCriterionText(run);
												return (
													<div
														key={run.runId}
														className="flex min-w-0 cursor-pointer items-center gap-3 py-1.5 pr-4 pl-12 text-sm hover:bg-muted/50"
														onClick={(event) => {
															event.stopPropagation();
															navigate(`/runs/${encodeURIComponent(run.runId)}`);
														}}
													>
														{run.status === "completed" ? (
															<CircleCheck className="size-3.5 shrink-0 text-green-700 dark:text-green-400" />
														) : (
															<CircleX className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />
														)}
														<EvalHoverCard
															evalTarget={run.evalTarget}
															kind={run.kind}
															tier={run.tier}
															description={run.description}
															startPrompt={run.startPrompt}
														>
															<span className="block max-w-72 truncate font-medium">
																{run.evalTarget}
															</span>
														</EvalHoverCard>
														<EvalKindBadge
															evalTarget={run.evalTarget}
															kind={run.kind}
														/>
														<EvalTierBadge tier={run.tier} />
														{batch.models.length > 1 ? (
															<span className="text-xs text-muted-foreground">
																{run.model ?? "default model"}
															</span>
														) : null}
														{run.status === "failed" && failedText ? (
															<span
																className="min-w-0 flex-1 truncate text-xs text-red-600 dark:text-red-400"
																title={failedText}
															>
																{failedText}
															</span>
														) : (
															<span className="flex-1" />
														)}
														<div className="ml-auto flex shrink-0 items-center gap-3 text-xs tabular-nums">
															{scorePct == null ? (
																<span className="text-muted-foreground">
																	{missing}
																</span>
															) : (
																<span className={scoreClass(scorePct)}>
																	{scorePct}%
																</span>
															)}
															<span className="text-muted-foreground">
																{durationOf(run)}
															</span>
														</div>
													</div>
												);
												})
											) : null}
										</div>
									</TableCell>
								</TableRow>
							) : null}
						</Fragment>
					);
				})}
			</TableBody>
		</Table>
	);
}
