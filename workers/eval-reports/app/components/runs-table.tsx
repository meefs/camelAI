import { Badge } from "@/components/ui/badge";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Link, useNavigate } from "react-router";
import { VerdictBadge } from "./verdict-badge";
import { scoreClass } from "./score";
import { EvalNameCell } from "./eval-name-cell";
import {
	durationOf,
	displayedFailures,
	fmtCost,
	missing,
	shortPerson,
	whenText,
	whenTitle,
} from "../lib/format";
import type { Run } from "../../src/types";

export function BranchCell({
	run,
	refName,
	commit,
}: {
	run?: Run;
	refName?: string;
	commit?: string;
}) {
	const ref = refName ?? run?.ref;
	const sha = commit ?? run?.commit;
	if (!ref && !sha) return <span className="text-muted-foreground">{missing}</span>;
	return (
		<div className="max-w-40 truncate font-mono text-xs">
			{ref ? <span>{ref}</span> : null}
			{sha ? (
				<span className="ml-1 text-muted-foreground">{sha.slice(0, 7)}</span>
			) : null}
		</div>
	);
}

function ActivityCell({ run }: { run: Run }) {
	const signal = run.signal;
	if (!signal) return <span className="text-muted-foreground">{missing}</span>;
	const parts = [
		typeof signal.assistantTurnCount === "number"
			? `${signal.assistantTurnCount} turns`
			: "",
		typeof signal.tokenUsage?.costUsd === "number"
			? fmtCost(signal.tokenUsage.costUsd)
			: "",
	].filter(Boolean);
	const bad = signal.badToolCallCount ?? 0;
	const violations = signal.violations?.length ?? 0;
	if (!parts.length && bad === 0 && violations === 0) {
		return <span className="text-muted-foreground">{missing}</span>;
	}
	return (
		<div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
			{parts.length ? <span>{parts.join(" · ")}</span> : null}
			{bad > 0 ? <Badge variant="destructive">{bad} bad</Badge> : null}
			{violations > 0 ? (
				<Badge variant="destructive">
					{violations} violation{violations === 1 ? "" : "s"}
				</Badge>
			) : null}
		</div>
	);
}

function ResultCell({ run }: { run: Run }) {
	const failed = displayedFailures(run);
	const badge = <VerdictBadge status={run.status} />;
	if (run.status !== "failed" || failed.length === 0) return badge;
	return (
		<HoverCard openDelay={150}>
			<HoverCardTrigger asChild>
				<span className="inline-flex">{badge}</span>
			</HoverCardTrigger>
			<HoverCardContent align="start" className="w-80">
				<p className="text-xs font-medium text-destructive">
					{failed.length} failed {failed.length === 1 ? "criterion" : "criteria"}
				</p>
				<div className="mt-2 space-y-2">
					{failed.slice(0, 5).map((criterion) => (
						<div key={criterion.id} className="text-xs">
							<p className="font-medium">{criterion.label}</p>
							{criterion.reason ? (
								<p className="mt-0.5 line-clamp-2 text-muted-foreground">
									{criterion.reason}
								</p>
							) : null}
						</div>
					))}
					{failed.length > 5 ? (
						<p className="text-xs text-muted-foreground">
							+{failed.length - 5} more
						</p>
					) : null}
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}

function ScoreCell({ run }: { run: Run }) {
	const score = run.evaluation?.scorecard;
	const scorePct =
		score && typeof score.percentage === "number"
			? Math.round(score.percentage)
			: null;
	if (scorePct == null || !score) {
		return <span className="text-muted-foreground">{missing}</span>;
	}
	return (
		<div>
			<div className={`font-medium tabular-nums ${scoreClass(scorePct)}`}>
				{scorePct}%
			</div>
			<div className="text-xs text-muted-foreground tabular-nums">
				{score.points}/{score.maxPoints}
			</div>
		</div>
	);
}

function FailureCell({ run }: { run: Run }) {
	const criterion = displayedFailures(run)[0];
	if (run.status !== "failed" || !criterion) {
		return <span className="text-muted-foreground">{missing}</span>;
	}
	const text = `${criterion.label}${criterion.reason ? ` — ${criterion.reason}` : ""}`;
	return (
		<div
			className="max-w-[28rem] truncate text-sm text-muted-foreground"
			title={text}
		>
			{text}
		</div>
	);
}

function BatchLinkCell({ run }: { run: Run }) {
	if (!run.batchId) return <span className="text-muted-foreground">{missing}</span>;
	return (
		<Link
			to={`/batches/${encodeURIComponent(run.batchId)}`}
			onClick={(event) => event.stopPropagation()}
			className="block max-w-32 truncate text-xs text-muted-foreground hover:text-foreground"
			title={run.batchLabel ?? run.batchId}
		>
			{run.batchLabel ?? "batch"}
		</Link>
	);
}

export function RunsTable({
	runs,
	showBranch = true,
	showModel = true,
	showBatch = false,
}: {
	runs: Run[];
	showBranch?: boolean;
	showModel?: boolean;
	showBatch?: boolean;
}) {
	const navigate = useNavigate();
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead className="w-24">Result</TableHead>
					<TableHead>Eval</TableHead>
					<TableHead className="w-24">Score</TableHead>
					<TableHead>Failure</TableHead>
					{showBatch ? (
						<TableHead className="hidden w-32 lg:table-cell">Batch</TableHead>
					) : null}
					{showBranch ? (
						<TableHead className="hidden md:table-cell">Branch</TableHead>
					) : null}
					<TableHead className="hidden md:table-cell">Activity</TableHead>
					<TableHead className="hidden w-24 sm:table-cell">Duration</TableHead>
					<TableHead className="w-28">Finished</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{runs.map((run) => (
					<TableRow
						key={run.runId}
						className="cursor-pointer"
						onClick={() => navigate(`/runs/${encodeURIComponent(run.runId)}`)}
					>
						<TableCell>
							<ResultCell run={run} />
						</TableCell>
						<TableCell>
							<EvalNameCell
								run={run}
								to={`/runs/${encodeURIComponent(run.runId)}`}
								showModel={showModel}
							/>
						</TableCell>
						<TableCell>
							<ScoreCell run={run} />
						</TableCell>
						<TableCell>
							<FailureCell run={run} />
						</TableCell>
						{showBatch ? (
							<TableCell className="hidden lg:table-cell">
								<BatchLinkCell run={run} />
							</TableCell>
						) : null}
						{showBranch ? (
							<TableCell className="hidden md:table-cell">
								<BranchCell run={run} />
							</TableCell>
						) : null}
						<TableCell className="hidden md:table-cell">
							<ActivityCell run={run} />
						</TableCell>
						<TableCell className="hidden text-sm text-muted-foreground tabular-nums sm:table-cell">
							{durationOf(run)}
						</TableCell>
						<TableCell>
							<div className="text-sm text-muted-foreground" title={whenTitle(run)}>
								{whenText(run)}
							</div>
							<div className="text-xs text-muted-foreground/70">
								{shortPerson(run.createdBy)}
							</div>
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
