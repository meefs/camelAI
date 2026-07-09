import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/ui/tabs";
import {
	ArrowRight,
	Check,
	Copy,
	ExternalLink,
	TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	Link,
	type LoaderFunctionArgs,
	useLoaderData,
	useSearchParams,
} from "react-router";
import { BackButton } from "../components/back-button";
import { CriteriaCard } from "../components/criteria-card";
import { EvalKindBadge } from "../components/eval-name-cell";
import { PromptSection } from "../components/prompt-section";
import { ScoreValue } from "../components/score";
import { ScorecardCard } from "../components/scorecard-card";
import { TextViewer } from "../components/text-viewer";
import { TranscriptView } from "../components/transcript/transcript-view";
import { VerdictBadge } from "../components/verdict-badge";
import { fetchLog, fetchRun } from "../lib/api";
import {
	contractFailureReason,
	durationOf,
	failedCriteria,
	fmtCost,
	fmtInt,
	fmtTokens,
	missing,
	safeHttpUrl,
	scoreParts,
	stripAnsi,
	whenText,
	whenTitle,
} from "../lib/format";
import type { Run } from "../../src/types";

const DEFAULT_TAB = "overview";
const tabs = ["overview", "transcript", "log", "raw"] as const;
type DetailTab = (typeof tabs)[number];

export async function runLoader({ params }: LoaderFunctionArgs) {
	if (!params.runId) throw new Response("Run not found", { status: 404 });
	return fetchRun(params.runId);
}

export function SeparatorDot() {
	return <span className="text-border">·</span>;
}

function MetaLine({ run }: { run: Run }) {
	const items: React.ReactNode[] = [];
	if (run.model) items.push(run.model);
	if (run.ref || run.commit) {
		items.push(
			<span className="font-mono text-xs">
				{run.ref}
				{run.ref && run.commit ? "@" : ""}
				{run.commit?.slice(0, 7)}
			</span>,
		);
	}
	const duration = durationOf(run);
	if (duration !== missing) items.push(duration);
	if (whenText(run) !== missing) {
		items.push(
			<span title={whenTitle(run)}>finished {whenText(run)}</span>,
		);
	}
	if (run.createdBy) items.push(`by ${run.createdBy}`);
	if (run.host) items.push(run.host);
	if (run.realDeploy) items.push(<Badge variant="outline">real deploy</Badge>);

	return (
		<div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
			{items.map((item, index) => (
				<span key={index} className="inline-flex items-center gap-2">
					{index > 0 ? <SeparatorDot /> : null}
					{item}
				</span>
			))}
		</div>
	);
}

export function RunIdLine({
	runId,
	copyLabel = "Copy run id",
	children,
}: {
	runId: string;
	copyLabel?: string;
	children?: React.ReactNode;
}) {
	const [copied, setCopied] = useState(false);
	async function copyRunId() {
		await navigator.clipboard.writeText(runId);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1500);
	}
	return (
		<div className="mt-1 flex items-center gap-1">
			<span className="font-mono text-xs text-muted-foreground">{runId}</span>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="size-6"
				aria-label={copyLabel}
				onClick={copyRunId}
			>
				{copied ? <Check /> : <Copy />}
			</Button>
			{children}
		</div>
	);
}

export function StatTile({
	label,
	value,
	title,
	destructive = false,
	children,
}: {
	label: string;
	value: React.ReactNode;
	title?: string;
	destructive?: boolean;
	children?: React.ReactNode;
}) {
	return (
		<div className="bg-card px-4 py-3">
			<p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
				{label}
			</p>
			<p
				className={`mt-1 text-sm font-medium tabular-nums ${
					destructive ? "text-destructive" : ""
				}`}
				title={title}
			>
				{value}
				{children}
			</p>
		</div>
	);
}

function OverviewTab({ run }: { run: Run }) {
	const contractReason = contractFailureReason(run);
	const hasContractFailure = !run.evaluation || Boolean(contractReason);
	const usage = run.signal?.tokenUsage;
	const badToolCalls = run.signal?.badToolCallCount ?? 0;
	const runErrorDuplicated =
		Boolean(run.error && contractReason && run.error === contractReason);

	return (
		<div className="space-y-4">
			{hasContractFailure ? (
				<Alert variant="destructive">
					<TriangleAlert />
					<AlertTitle>Evaluation contract failure</AlertTitle>
					<AlertDescription>
						{contractReason ??
							"No valid evaluation object was found in the eval artifact."}
					</AlertDescription>
				</Alert>
			) : null}
			{run.error && !runErrorDuplicated ? (
				<Alert variant="destructive">
					<TriangleAlert />
					<AlertTitle>Run error</AlertTitle>
					<AlertDescription className="whitespace-pre-wrap font-mono text-xs">
						{run.error}
					</AlertDescription>
				</Alert>
			) : null}
			{run.signal?.violations?.length ? (
				<Alert className="border-amber-500/40 text-amber-700 dark:text-amber-400 [&>svg]:text-current">
					<TriangleAlert />
					<AlertTitle>Signal violations</AlertTitle>
					<AlertDescription>
						<ul className="list-disc pl-4">
							{run.signal.violations.map((violation) => (
								<li key={violation}>{violation}</li>
							))}
						</ul>
					</AlertDescription>
				</Alert>
			) : null}
			<div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3 lg:grid-cols-6">
				<StatTile label="Turns" value={fmtInt(run.signal?.assistantTurnCount)} />
				<StatTile label="Tool calls" value={fmtInt(run.signal?.toolCallCount)}>
					{badToolCalls > 0 ? (
						<span className="ml-1 text-destructive">({badToolCalls} bad)</span>
					) : null}
				</StatTile>
				<StatTile
					label="Tokens"
					value={fmtTokens(usage?.totalTokens)}
					title={`Input ${fmtInt(usage?.inputTokens)} / Output ${fmtInt(
						usage?.outputTokens,
					)}`}
				/>
				<StatTile label="Cost" value={fmtCost(usage?.costUsd)} />
				<StatTile
					label="Exit code"
					value={run.exitCode ?? missing}
					destructive={Boolean(run.exitCode)}
				/>
				<StatTile
					label="Real deploy"
					value={
						run.realDeploy === undefined ? missing : run.realDeploy ? "yes" : "no"
					}
				/>
			</div>
			{run.evaluation ? (
				<div className="grid gap-4 lg:grid-cols-2">
					<CriteriaCard evaluation={run.evaluation} />
					{run.evaluation.scorecard ? (
						<ScorecardCard evaluation={run.evaluation} />
					) : null}
				</div>
			) : null}
			{run.deployedApps?.length ? (
				<Card>
					<CardHeader>
						<CardTitle>Deployed apps</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="divide-y">
							{run.deployedApps.map((app) => {
								const href = safeHttpUrl(app.url);
								const content = (
									<>
										<span className="text-sm font-medium group-hover:underline">
											{app.name}
										</span>
										<span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
											{app.url}
										</span>
										<ExternalLink className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
									</>
								);
								return href ? (
									<a
										key={`${app.name}-${app.url}`}
										href={href}
										target="_blank"
										rel="noopener"
										className="group flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
									>
										{content}
									</a>
								) : (
									<div
										key={`${app.name}-${app.url}`}
										className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
									>
										{content}
									</div>
								);
							})}
						</div>
					</CardContent>
				</Card>
			) : null}
		</div>
	);
}

function LogTab({ runId, active }: { runId: string; active: boolean }) {
	const [log, setLog] = useState<string | null | undefined>(undefined);

	useEffect(() => {
		if (!active || log !== undefined) return;
		let cancelled = false;
		fetchLog(runId)
			.then((text) => {
				if (!cancelled) setLog(text == null ? null : stripAnsi(text));
			})
			.catch(() => {
				if (!cancelled) setLog(null);
			});
		return () => {
			cancelled = true;
		};
	}, [active, log, runId]);

	return (
		<TextViewer
			filename="output.log"
			text={log}
			loading={log === undefined}
			rawHref={`/api/runs/${encodeURIComponent(runId)}/log`}
			emptyMessage="(no output captured)"
		/>
	);
}

export function RunDetailPage() {
	const run = useLoaderData<typeof runLoader>();
	const [params, setParams] = useSearchParams();
	const rawTab = params.get("tab") ?? DEFAULT_TAB;
	const tab = tabs.includes(rawTab as DetailTab) ? (rawTab as DetailTab) : DEFAULT_TAB;
	const score = scoreParts(run);

	function setTab(value: string) {
		const next = new URLSearchParams(params);
		if (value === DEFAULT_TAB) next.delete("tab");
		else next.set("tab", value);
		setParams(next, { replace: true });
	}

	return (
		<div>
			<BackButton fallback="/" />
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-3">
						<VerdictBadge status={run.status} size="lg" />
						<EvalKindBadge evalTarget={run.evalTarget} kind={run.kind} />
						<h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">
							{run.evalTarget}
						</h1>
					</div>
					<MetaLine run={run} />
					<RunIdLine runId={run.runId}>
						{run.batchId ? (
							<>
								<SeparatorDot />
								<Link
									to={`/batches/${encodeURIComponent(run.batchId)}`}
									className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
								>
									in {run.batchLabel ?? "batch"}
									<ArrowRight className="size-3" />
								</Link>
							</>
						) : null}
					</RunIdLine>
				</div>
				{score && score.maxPoints > 0 ? (
					<ScoreValue
						percentage={score.percentage}
						points={score.points}
						maxPoints={score.maxPoints}
						size="lg"
					/>
				) : null}
			</div>

			<PromptSection run={run} />

			<Tabs value={tab} onValueChange={setTab} className="mt-6">
				<TabsList variant="line">
					<TabsTrigger value="overview">Overview</TabsTrigger>
					<TabsTrigger value="transcript">Transcript</TabsTrigger>
					<TabsTrigger value="log">Log</TabsTrigger>
					<TabsTrigger value="raw">Raw JSON</TabsTrigger>
				</TabsList>
				<TabsContent value="overview" className="mt-4">
					<OverviewTab run={run} />
				</TabsContent>
					<TabsContent value="transcript" className="mt-4">
						<TranscriptView
							key={run.runId}
							runId={run.runId}
							active={tab === "transcript"}
						/>
					</TabsContent>
					<TabsContent value="log" className="mt-4">
						{tab === "log" ? (
							<LogTab key={run.runId} runId={run.runId} active />
						) : (
							<Skeleton className="h-32" />
						)}
					</TabsContent>
					<TabsContent value="raw" className="mt-4">
						<TextViewer
							key={run.runId}
							filename="run.json"
							text={JSON.stringify(run, null, 2)}
							emptyMessage="(no run record)"
					/>
				</TabsContent>
			</Tabs>
		</div>
	);
}
