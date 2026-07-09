import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CircleAlert, CircleCheck, CircleX } from "lucide-react";

export function BatchResultBadge({
	passed,
	total,
	size = "default",
}: {
	passed: number;
	total: number;
	size?: "default" | "lg";
}) {
	const lg = size === "lg" ? "h-6 px-2.5 text-xs [&>svg]:size-3.5!" : "";
	const text =
		size === "lg"
			? `${passed}/${total} ${passed === total ? "Passed" : passed === 0 ? "Failed" : "Passed"}`
			: `${passed}/${total}`;
	if (passed === total && total > 0) {
		return (
			<Badge
				className={cn(
					"border-transparent bg-green-600/10 text-green-700 dark:bg-green-500/15 dark:text-green-400",
					lg,
				)}
			>
				<CircleCheck data-icon="inline-start" />
				{text}
			</Badge>
		);
	}
	if (passed > 0) {
		return (
			<Badge
				className={cn(
					"border-transparent bg-amber-500/15 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
					lg,
				)}
			>
				<CircleAlert data-icon="inline-start" />
				{text}
			</Badge>
		);
	}
	return (
		<Badge variant="destructive" className={lg}>
			<CircleX data-icon="inline-start" />
			{text}
		</Badge>
	);
}
