import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";

export function TextViewer({
	filename,
	text,
	rawHref,
	loading = false,
	emptyMessage = "(no output captured)",
}: {
	filename: string;
	text?: string | null;
	rawHref?: string;
	loading?: boolean;
	emptyMessage?: string;
}) {
	const [copied, setCopied] = useState(false);
	const display = text ?? "";

	async function copyText() {
		await navigator.clipboard.writeText(display);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1500);
	}

	return (
		<div className="rounded-xl border">
			<div className="flex items-center justify-between gap-3 border-b px-4 py-2">
				<span className="font-mono text-xs text-muted-foreground">{filename}</span>
				<div className="flex items-center gap-1">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={copyText}
						disabled={loading || !display}
					>
						{copied ? <Check /> : <Copy />}
						Copy
					</Button>
					{rawHref ? (
						<Button variant="ghost" size="sm" asChild>
							<a href={rawHref} target="_blank" rel="noopener">
								<ExternalLink />
								Raw
							</a>
						</Button>
					) : null}
				</div>
			</div>
			{loading ? (
				<div className="space-y-3 p-4">
					<Skeleton className="h-4 w-11/12" />
					<Skeleton className="h-4 w-4/5" />
					<Skeleton className="h-4 w-2/3" />
				</div>
			) : display ? (
				<pre className="max-h-[70vh] overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
					{display}
				</pre>
			) : (
				<div className="py-12 text-center text-sm text-muted-foreground">
					{emptyMessage}
				</div>
			)}
		</div>
	);
}
