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
import { ChevronRight, CircleCheck, CircleX } from "lucide-react";
import type { EvalCriteriaSummary, JsonValue } from "../../src/types";

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

export function CriteriaCard({ evaluation }: { evaluation: EvalCriteriaSummary }) {
	const criteria = [...(evaluation.passFail.criteria ?? [])].sort((a, b) => {
		if (a.status === b.status) return 0;
		return a.status === "failed" ? -1 : 1;
	});
	const total = evaluation.passFail.total ?? criteria.length;
	const failed = evaluation.passFail.failed ?? criteria.filter((c) => c.status === "failed").length;
	const passed = Math.max(0, total - failed);

	return (
		<Card>
			<CardHeader>
				<CardTitle>Criteria</CardTitle>
				<CardDescription>
					{failed > 0 ? (
						<>
							{passed} passed ·{" "}
							<span className="font-medium text-destructive">{failed} failed</span>
						</>
					) : (
						<>All {total} passed</>
					)}
				</CardDescription>
			</CardHeader>
			<CardContent>
				{criteria.length ? (
					<div className="divide-y">
						{criteria.map((criterion) => {
							const passed = criterion.status === "passed";
							const Icon = passed ? CircleCheck : CircleX;
							return (
								<div
									key={criterion.id}
									className="flex gap-3 py-3 first:pt-0 last:pb-0"
								>
									<Icon
										className={
											passed
												? "mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-400"
												: "mt-0.5 size-4 shrink-0 text-destructive"
										}
									/>
									<div className="min-w-0 flex-1">
										<p className="text-sm font-medium">{criterion.label}</p>
										{criterion.reason ? (
											<p className="text-sm text-muted-foreground">
												{criterion.reason}
											</p>
										) : null}
										<Details details={criterion.details} />
									</div>
								</div>
							);
						})}
					</div>
				) : (
					<p className="text-sm text-muted-foreground">No pass/fail criteria.</p>
				)}
			</CardContent>
		</Card>
	);
}
