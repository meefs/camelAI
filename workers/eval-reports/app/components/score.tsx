import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export type ScoreBand = "good" | "mid" | "bad";

export const scoreBand = (pct: number): ScoreBand =>
	pct >= 80 ? "good" : pct >= 50 ? "mid" : "bad";

export const scoreTextClass: Record<ScoreBand, string> = {
	good: "text-green-700 dark:text-green-400",
	mid: "text-amber-600 dark:text-amber-400",
	bad: "text-red-600 dark:text-red-400",
};

const scoreBarClass: Record<ScoreBand, string> = {
	good: "[&_[data-slot=progress-indicator]]:bg-green-600 dark:[&_[data-slot=progress-indicator]]:bg-green-500",
	mid: "[&_[data-slot=progress-indicator]]:bg-amber-500",
	bad: "[&_[data-slot=progress-indicator]]:bg-red-600 dark:[&_[data-slot=progress-indicator]]:bg-red-500",
};

export function scoreClass(percentage: number): string {
	return scoreTextClass[scoreBand(percentage)];
}

function clampScore(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export function ScoreBar({
	value,
	className,
}: {
	value: number;
	className?: string;
}) {
	const clamped = clampScore(value);
	return (
		<Progress
			value={clamped}
			className={cn(scoreBarClass[scoreBand(clamped)], className)}
		/>
	);
}

export function ScoreValue({
	percentage,
	points,
	maxPoints,
	size = "default",
}: {
	percentage?: number;
	points?: number;
	maxPoints?: number;
	size?: "default" | "lg";
}) {
	if (typeof percentage !== "number" || !Number.isFinite(percentage)) {
		return <span className="text-muted-foreground">—</span>;
	}
	const pct = Math.round(percentage);
	return (
		<div className={cn(size === "lg" && "text-right")}>
			<div
				className={cn(
					"font-medium tabular-nums",
					size === "lg" ? "text-2xl font-semibold" : "text-sm",
					scoreClass(pct),
				)}
			>
				{pct}%
			</div>
			{typeof points === "number" && typeof maxPoints === "number" ? (
				<div className="text-xs text-muted-foreground tabular-nums">
					{points}/{maxPoints}
					{size === "lg" ? " pts" : ""}
				</div>
			) : null}
		</div>
	);
}
