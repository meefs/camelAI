import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router";
import { EvalHoverCard, EvalKindBadge } from "./eval-name-cell";
import { scoreClass } from "./score";
import { VerdictBadge } from "./verdict-badge";
import { relTime } from "../lib/format";
import type { EvalRollup } from "../lib/batches";
import type { RunStatus } from "../../src/types";

function statusLabel(status: RunStatus): string {
	return status === "completed" ? "Pass" : "Fail";
}

export function EvalsRollup({ rollups }: { rollups: EvalRollup[] }) {
	const navigate = useNavigate();
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Eval</TableHead>
					<TableHead className="w-28">Last 5</TableHead>
					<TableHead className="w-24">Pass rate</TableHead>
					<TableHead className="w-24">Avg score</TableHead>
					<TableHead className="w-28">Last run</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rollups.map((rollup) => {
					const passPct = rollup.runs
						? Math.round((rollup.passed / rollup.runs) * 100)
						: 0;
					return (
						<TableRow
							key={rollup.evalTarget}
							className="cursor-pointer"
							onClick={() =>
								navigate(
									`/?view=runs&eval=${encodeURIComponent(rollup.evalTarget)}`,
								)
							}
						>
							<TableCell>
								<div className="min-w-0">
									<div className="flex min-w-0 items-center gap-2">
										<EvalHoverCard
											evalTarget={rollup.evalTarget}
											kind={rollup.kind}
											description={rollup.description}
											startPrompt={rollup.startPrompt}
										>
											<span className="min-w-0 max-w-96 truncate font-medium">
												{rollup.evalTarget}
											</span>
										</EvalHoverCard>
										<EvalKindBadge
											evalTarget={rollup.evalTarget}
											kind={rollup.kind}
										/>
									</div>
									{rollup.description ? (
										<div className="max-w-96 truncate text-xs text-muted-foreground">
											{rollup.description}
										</div>
									) : null}
								</div>
							</TableCell>
							<TableCell>
								<div className="flex items-center gap-1">
									{rollup.recentRuns.map((run) => (
										<span
											key={run.runId}
											className={cn(
												"size-2 rounded-full",
												run.status === "completed"
													? "bg-green-600 dark:bg-green-500"
													: "bg-red-600 dark:bg-red-500",
											)}
											title={`${statusLabel(run.status)} · ${relTime(
												run.finishedAt ?? run.createdAt,
											)}`}
										/>
									))}
								</div>
							</TableCell>
							<TableCell>
								<div className={`font-medium tabular-nums ${scoreClass(passPct)}`}>
									{passPct}%
								</div>
								<div className="text-xs text-muted-foreground tabular-nums">
									×{rollup.runs}
								</div>
							</TableCell>
							<TableCell>
								{rollup.avgScorePct == null ? (
									<span className="text-muted-foreground">—</span>
								) : (
									<span
										className={`font-medium tabular-nums ${scoreClass(
											rollup.avgScorePct,
										)}`}
									>
										{rollup.avgScorePct}%
									</span>
								)}
							</TableCell>
							<TableCell>
								<VerdictBadge status={rollup.lastRun.status} />
								<div className="mt-1 text-xs text-muted-foreground">
									{relTime(rollup.lastRun.finishedAt ?? rollup.lastRun.createdAt)}
								</div>
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}
