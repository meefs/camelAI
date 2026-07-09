import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, Copy } from "lucide-react";
import { useState } from "react";
import type { Run } from "../../src/types";

export function PromptSection({ run }: { run: Run }) {
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const hasPrompt = Boolean(run.startPrompt);
	if (!hasPrompt && !run.description) return null;

	async function copyPrompt() {
		if (!run.startPrompt) return;
		await navigator.clipboard.writeText(run.startPrompt);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1500);
	}

	return (
		<Collapsible
			open={hasPrompt ? open : false}
			onOpenChange={setOpen}
			className="mt-5 rounded-lg border bg-muted/30"
		>
			<div className="flex items-center gap-2 px-3 py-2">
				<p className="text-[10px] font-medium tracking-wide text-muted-foreground">
					PROMPT
				</p>
				<div className="flex-1" />
				{hasPrompt ? (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="Copy prompt"
						onClick={copyPrompt}
					>
						{copied ? <Check /> : <Copy />}
					</Button>
				) : null}
				{hasPrompt ? (
					<CollapsibleTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={open ? "Collapse prompt" : "Expand prompt"}
						>
							<ChevronDown
								className={cn(
									"transition-transform",
									open ? "rotate-180" : "rotate-0",
								)}
							/>
						</Button>
					</CollapsibleTrigger>
				) : null}
			</div>
			<div className="px-3 pb-2">
				{run.description ? (
					<p className="text-xs text-muted-foreground">{run.description}</p>
				) : null}
				{hasPrompt ? (
					!open ? (
						<CollapsibleTrigger asChild>
							<button
								type="button"
								className="mt-1 block w-full text-left text-sm"
								aria-label="Expand prompt"
							>
								<span className="line-clamp-2 whitespace-pre-wrap">
									{run.startPrompt}
								</span>
							</button>
						</CollapsibleTrigger>
					) : null
				) : (
					<p className="mt-1 text-sm italic text-muted-foreground">
						Prompt not captured for this run
					</p>
				)}
			</div>
			{hasPrompt ? (
				<CollapsibleContent>
					<ScrollArea className="px-3 pb-3" viewportClassName="max-h-72">
						<p className="whitespace-pre-wrap pr-3 text-sm">{run.startPrompt}</p>
					</ScrollArea>
				</CollapsibleContent>
			) : null}
		</Collapsible>
	);
}
