import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Bot, Brain, ChevronRight, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchArtifact, fetchArtifactNames } from "../../lib/api";
import {
	buildRenderMessages,
	stringify,
	type TranscriptArtifact,
	type RenderBlock,
} from "../../lib/transcript";
import { Markdown } from "./markdown";
import { ToolCallBlock } from "./tool-call-block";

function EmptyTranscript({ children }: { children: string }) {
	return (
		<div className="py-16 text-center text-sm text-muted-foreground">{children}</div>
	);
}

function BlockView({ block }: { block: RenderBlock }) {
	switch (block.kind) {
		case "text":
			return <Markdown>{block.text}</Markdown>;
		case "thinking":
			return (
				<Collapsible>
					<CollapsibleTrigger asChild>
						<button className="inline-flex items-center gap-1.5 text-xs italic text-muted-foreground hover:text-foreground [&[data-state=open]>svg:first-child]:rotate-90">
							<ChevronRight className="size-3 transition-transform" />
							<Brain className="size-3" />
							Thinking
						</button>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="mt-2 whitespace-pre-wrap border-l-2 pl-3 text-sm italic text-muted-foreground">
							{block.text}
						</div>
					</CollapsibleContent>
				</Collapsible>
			);
		case "redacted_thinking":
			return (
				<div className="inline-flex items-center gap-1.5 text-xs italic text-muted-foreground">
					<Brain className="size-3" />
					Reasoning redacted
				</div>
			);
		case "tool_use":
			return <ToolCallBlock call={block.call} result={block.result} />;
		case "tool_result":
			return <ToolCallBlock result={block.result} resultOnly />;
		case "unknown":
			return (
				<pre className="rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
					{stringify(block.block)}
				</pre>
			);
	}
}

function ArtifactView({ artifact }: { artifact: TranscriptArtifact }) {
	const messages = useMemo(
		() => buildRenderMessages(artifact.messages ?? []),
		[artifact.messages],
	);

	if (!artifact.result && messages.length === 0) {
		return <EmptyTranscript>No messages in transcript.</EmptyTranscript>;
	}

	return (
		<div className="max-w-3xl space-y-4">
			{artifact.result ? (
				<Card>
					<CardHeader>
						<CardTitle>Result</CardTitle>
					</CardHeader>
					<CardContent>
						<Markdown>{artifact.result}</Markdown>
					</CardContent>
				</Card>
			) : null}
			{messages.map((message, index) => {
				const isUser = message.role === "user";
				const Icon = isUser ? User : Bot;
				return (
					<div key={index}>
						<div className="mb-2 flex items-center gap-2">
							<span className="flex size-5 items-center justify-center rounded-full bg-muted">
								<Icon className="size-3 text-muted-foreground" />
							</span>
							<span className="text-xs font-medium text-muted-foreground">
								{isUser ? "User" : "Assistant"}
							</span>
						</div>
						<div
							className={
								isUser ? "space-y-3 rounded-lg bg-muted/50 px-4 py-3" : "space-y-3"
							}
						>
							{message.blocks.map((block, blockIndex) => (
								<BlockView key={blockIndex} block={block} />
							))}
						</div>
					</div>
				);
			})}
		</div>
	);
}

export function TranscriptView({ runId, active }: { runId: string; active: boolean }) {
	const [artifactNames, setArtifactNames] = useState<string[] | null>(null);
	const [selected, setSelected] = useState<string>("");
	const [cache, setCache] = useState<Record<string, TranscriptArtifact>>({});
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!active || artifactNames !== null) return;
		let cancelled = false;
		setLoading(true);
		fetchArtifactNames(runId)
			.then((names) => {
				if (cancelled) return;
				setArtifactNames(names);
				setSelected(names[0] ?? "");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : "Could not load artifacts.");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [active, artifactNames, runId]);

	useEffect(() => {
		if (!active || !selected || cache[selected]) return;
		let cancelled = false;
		setLoading(true);
		fetchArtifact(runId, selected)
			.then((artifact) => {
				if (cancelled) return;
				setCache((current) => ({ ...current, [selected]: artifact }));
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : "Could not load transcript.");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [active, cache, runId, selected]);

	if (loading && artifactNames === null) {
		return (
			<div className="max-w-3xl space-y-4">
				<Skeleton className="h-28 w-full" />
				<Skeleton className="h-40 w-full" />
			</div>
		);
	}
	if (error) return <EmptyTranscript>{error}</EmptyTranscript>;
	if (artifactNames && artifactNames.length === 0) {
		return <EmptyTranscript>No transcript artifact for this run.</EmptyTranscript>;
	}

	const artifact = selected ? cache[selected] : undefined;

	return (
		<div>
			{artifactNames && artifactNames.length > 1 ? (
				<div className="mb-3 flex justify-end">
					<Select value={selected} onValueChange={setSelected}>
						<SelectTrigger size="sm" className="h-8 w-64 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{artifactNames.map((name) => (
								<SelectItem key={name} value={name}>
									{name.replace(/\.json$/, "")}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : null}
			{loading && !artifact ? (
				<div className="max-w-3xl space-y-3">
					<Skeleton className="h-5 w-40" />
					<Skeleton className="h-32 w-full" />
				</div>
			) : artifact ? (
				<ArtifactView artifact={artifact} />
			) : null}
		</div>
	);
}
