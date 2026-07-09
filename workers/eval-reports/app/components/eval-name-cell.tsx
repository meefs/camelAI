import { Badge } from "@/components/ui/badge";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { EvalKind, Run } from "../../src/types";

export function EvalKindBadge({
	evalTarget,
	kind,
}: {
	evalTarget: string;
	kind?: EvalKind;
}) {
	if (evalTarget === "custom-prompt-live") {
		return <Badge variant="outline">custom</Badge>;
	}
	return kind ? <Badge variant="secondary">{kind}</Badge> : null;
}

export function EvalHoverCard({
	evalTarget,
	kind,
	description,
	startPrompt,
	children,
}: {
	evalTarget: string;
	kind?: EvalKind;
	description?: string;
	startPrompt?: string;
	children: ReactNode;
}) {
	return (
		<HoverCard openDelay={300} closeDelay={100}>
			<HoverCardTrigger asChild>{children}</HoverCardTrigger>
			<HoverCardContent
				className="w-[min(24rem,calc(100vw-2rem))] p-0"
				align="start"
			>
				<div className="space-y-1 p-3">
					<div className="flex items-center gap-2">
						<p className="min-w-0 flex-1 break-all text-sm font-medium">
							{evalTarget}
						</p>
						<EvalKindBadge evalTarget={evalTarget} kind={kind} />
					</div>
					{description ? (
						<p className="text-xs text-muted-foreground">{description}</p>
					) : null}
				</div>
				<Separator />
				<div className="space-y-2 p-3 pt-2">
					<p className="text-[10px] font-medium tracking-wide text-muted-foreground">
						START PROMPT
					</p>
					<ScrollArea viewportClassName="max-h-64">
						{startPrompt ? (
							<p className="whitespace-pre-wrap pr-3 text-xs">{startPrompt}</p>
						) : (
							<p className="text-xs italic text-muted-foreground">
								Prompt not captured for this run
							</p>
						)}
					</ScrollArea>
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}

export function EvalNameCell({
	run,
	to,
	showModel = true,
}: {
	run: Run;
	to: string;
	showModel?: boolean;
}) {
	return (
		<div>
			<div className="flex min-w-0 items-center gap-2">
				<EvalHoverCard
					evalTarget={run.evalTarget}
					kind={run.kind}
					description={run.description}
					startPrompt={run.startPrompt}
				>
					<Link
						to={to}
						onClick={(event) => event.stopPropagation()}
						className="block max-w-72 truncate font-medium text-foreground hover:underline"
					>
						{run.evalTarget}
					</Link>
				</EvalHoverCard>
				<EvalKindBadge evalTarget={run.evalTarget} kind={run.kind} />
			</div>
			{showModel ? (
				<div className="text-xs text-muted-foreground">
					{run.model ?? "default model"}
				</div>
			) : null}
		</div>
	);
}
