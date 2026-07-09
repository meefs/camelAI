import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import type { EvalCriteriaSummary, JsonValue } from "../../src/types";
import { ScoreBar, scoreClass } from "./score";

function Details({ details }: { details?: JsonValue }) {
	if (details === undefined) return null;
	return (
		<Collapsible>
			<CollapsibleTrigger asChild>
				<button className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&[data-state=open]>svg:first-child]:rotate-90">
					<ChevronRight className="size-3 transition-transform" />
					Details
				</button>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
					{JSON.stringify(details, null, 2)}
				</pre>
			</CollapsibleContent>
		</Collapsible>
	);
}

export function ScorecardCard({ evaluation }: { evaluation: EvalCriteriaSummary }) {
	const scorecard = evaluation.scorecard;
	const pct =
		typeof scorecard.percentage === "number" && Number.isFinite(scorecard.percentage)
			? Math.round(scorecard.percentage)
			: 0;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Scorecard</CardTitle>
				<CardDescription>
					{scorecard.points} of {scorecard.maxPoints} points
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex items-center gap-3">
					<ScoreBar value={pct} className="h-2 flex-1" />
					<span className={`text-sm font-medium tabular-nums ${scoreClass(pct)}`}>
						{pct}%
					</span>
				</div>
				{scorecard.criteria?.length ? (
					<div className="mt-3 divide-y">
						{scorecard.criteria.map((criterion) => {
							const rowPct =
								criterion.maxPoints > 0
									? Math.round((criterion.points / criterion.maxPoints) * 100)
									: 0;
							return (
								<div
									key={criterion.id}
									className="flex items-center gap-4 py-3"
								>
									<div className="min-w-0 flex-1">
										<p className="text-sm font-medium">{criterion.label}</p>
										{criterion.reason ? (
											<p className="text-sm text-muted-foreground">
												{criterion.reason}
											</p>
										) : null}
										<Details details={criterion.details} />
									</div>
									<ScoreBar value={rowPct} className="h-1.5 w-20 shrink-0" />
									<span className="w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
										{criterion.points}/{criterion.maxPoints}
									</span>
								</div>
							);
						})}
					</div>
				) : (
					<p className="mt-3 text-sm text-muted-foreground">No scored criteria.</p>
				)}
			</CardContent>
		</Card>
	);
}
