import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { CircleCheck, CircleX } from "lucide-react";
import { Link } from "react-router";
import { ScoreValue } from "./score";
import type { Run } from "../../src/types";

function modelName(run: Run): string {
	return run.model ?? "default model";
}

function runTime(run: Run): number {
	return new Date(run.finishedAt ?? run.createdAt).getTime() || 0;
}

export function BatchMatrix({ runs }: { runs: Run[] }) {
	const models = [...new Set(runs.map(modelName))].sort();
	if (models.length < 2) return null;
	const evalTargets = [...new Set(runs.map((run) => run.evalTarget))].sort();
	const grouped = new Map<string, Run[]>();
	for (const run of runs) {
		const key = `${run.evalTarget}\u0000${modelName(run)}`;
		const group = grouped.get(key);
		if (group) group.push(run);
		else grouped.set(key, [run]);
	}

	return (
		<Card>
			<CardHeader className="border-b">
				<CardTitle>Model × eval</CardTitle>
			</CardHeader>
			<CardContent className="p-0">
				<div className="overflow-x-auto">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="sticky left-0 z-10 bg-card whitespace-nowrap">
									Eval
								</TableHead>
								{models.map((model) => (
									<TableHead key={model} className="min-w-40 whitespace-nowrap">
										{model}
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{evalTargets.map((evalTarget) => (
								<TableRow key={evalTarget}>
									<TableCell className="sticky left-0 z-10 max-w-80 bg-card font-medium whitespace-nowrap">
										<span className="block truncate" title={evalTarget}>{evalTarget}</span>
									</TableCell>
									{models.map((model) => {
										const group = grouped.get(`${evalTarget}\u0000${model}`) ?? [];
										const latest = [...group].sort((left, right) => runTime(right) - runTime(left))[0];
										if (!latest) {
											return <TableCell key={model} className="text-center text-muted-foreground">–</TableCell>;
										}
										const percentage = latest.evaluation?.scorecard?.percentage;
										return (
											<TableCell key={model}>
												<Link
													to={`/runs/${encodeURIComponent(latest.runId)}`}
													className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-muted"
												>
													{latest.status === "completed" ? (
														<CircleCheck className="size-4 shrink-0 text-green-700 dark:text-green-400" />
													) : (
														<CircleX className="size-4 shrink-0 text-red-600 dark:text-red-400" />
													)}
													<ScoreValue percentage={percentage} />
													{group.length > 1 ? (
														<span className="text-xs text-muted-foreground">×{group.length}</span>
													) : null}
												</Link>
											</TableCell>
										);
									})}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</CardContent>
		</Card>
	);
}
