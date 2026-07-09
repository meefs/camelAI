import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CircleCheck, CircleX } from "lucide-react";
import type { RunStatus } from "../../src/types";

export function VerdictBadge({
	status,
	size = "default",
}: {
	status: RunStatus;
	size?: "default" | "lg";
}) {
	const lg = size === "lg" ? "h-6 px-2.5 text-xs [&>svg]:size-3.5!" : "";
	return status === "completed" ? (
		<Badge
			className={cn(
				"border-transparent bg-green-600/10 text-green-700 dark:bg-green-500/15 dark:text-green-400",
				lg,
			)}
		>
			<CircleCheck data-icon="inline-start" />
			Pass
		</Badge>
	) : (
		<Badge variant="destructive" className={lg}>
			<CircleX data-icon="inline-start" />
			Fail
		</Badge>
	);
}
