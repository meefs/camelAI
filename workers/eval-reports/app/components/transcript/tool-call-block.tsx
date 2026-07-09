import { Badge } from "@/components/ui/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight, Wrench } from "lucide-react";
import type { ToolResultBlock, ToolUseBlock } from "../../lib/transcript";
import { stringify, toolResultOut } from "../../lib/transcript";

function preview(value: unknown): string {
	const text = stringify(value).replace(/\s+/g, " ").trim();
	return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

function clipped(value: string): string {
	return value.length > 8000 ? `${value.slice(0, 8000)}\n...` : value;
}

export function ToolCallBlock({
	call,
	result,
	resultOnly = false,
}: {
	call?: ToolUseBlock;
	result?: ToolResultBlock;
	resultOnly?: boolean;
}) {
	const isError = Boolean(result?.is_error);
	const name = resultOnly ? "tool result" : call?.name ?? "tool";
	const inputText = call ? stringify(call.input) : "";
	const resultText = result ? clipped(toolResultOut(result)) : "";

	return (
		<Collapsible defaultOpen={isError}>
			<CollapsibleTrigger asChild>
				<button className="flex w-full items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-left text-xs hover:bg-muted/70 [&[data-state=open]>svg:first-child]:rotate-90">
					<ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform" />
					<Wrench className="size-3.5 shrink-0 text-muted-foreground" />
					<span className="shrink-0 font-mono font-medium">{name}</span>
					<span className="min-w-0 flex-1 truncate text-muted-foreground">
						{call ? preview(call.input) : preview(resultText)}
					</span>
					{isError ? <Badge variant="destructive">error</Badge> : null}
				</button>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="mt-1 space-y-2 rounded-md border bg-muted/20 p-3">
					{call ? (
						<div>
							<p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
								Input
							</p>
							<pre className="max-h-64 overflow-auto rounded-md border bg-background p-2.5 font-mono text-xs whitespace-pre-wrap break-words">
								{inputText}
							</pre>
						</div>
					) : null}
					<div>
						<p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							Result
						</p>
						{result ? (
							<pre className="max-h-80 overflow-auto rounded-md border bg-background p-2.5 font-mono text-xs whitespace-pre-wrap break-words">
								{resultText}
							</pre>
						) : (
							<p className="rounded-md border bg-background p-2.5 text-xs text-muted-foreground">
								(no result captured)
							</p>
						)}
					</div>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
