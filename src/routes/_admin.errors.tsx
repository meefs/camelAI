import { Link, useLoaderData } from 'react-router';
import { Bug, ExternalLink } from 'lucide-react';
import type { Route } from './+types/_admin.errors';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { requireSuperuser } from '@/lib/auth.server';
import * as authDO from '@/lib/auth-do.server';
import { cn } from '@/lib/utils';

const RANGE_OPTIONS = [
  { value: '24h', label: 'Last 24h', durationMs: 24 * 60 * 60 * 1000 },
  { value: '7d', label: 'Last 7d', durationMs: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: 'Last 30d', durationMs: 30 * 24 * 60 * 60 * 1000 },
] as const;

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function meta() {
  return [
    { title: 'Errors - Admin - camelAI' },
    { name: 'description', content: 'Top chat errors by rolling window' },
  ];
}

export function resolveErrorRange(value: string | null, now = Date.now()) {
  const selected = RANGE_OPTIONS.find((option) => option.value === value) ?? RANGE_OPTIONS[0];
  return {
    range: selected.value,
    startAt: now - selected.durationMs,
    endAt: now,
  };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const url = new URL(request.url);
  const { range, startAt, endAt } = resolveErrorRange(url.searchParams.get('range'));
  const fingerprint = url.searchParams.get('fingerprint')?.trim() || null;
  const dashboard = await authDO.adminGetChatErrorDashboard(context, {
    startAt,
    endAt,
    fingerprint,
    limit: 50,
  });

  return {
    ...dashboard,
    range,
    startAt,
    endAt,
    fingerprint,
  };
}

export default function AdminErrorsPage() {
  const data = useLoaderData<typeof loader>();
  const selectedFingerprint = data.fingerprint;

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Errors' },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-5 md:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Errors</h1>
              <p className="text-sm text-muted-foreground">
                Chat error groups from the selected rolling window
              </p>
            </div>
            <div className="inline-flex rounded-md border bg-background p-0.5">
              {RANGE_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  asChild
                  variant={data.range === option.value ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 rounded-sm"
                >
                  <Link to={getRangeHref(option.value, selectedFingerprint)}>
                    {option.label}
                  </Link>
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-4">
            <SummaryMetric label="Events" value={data.summary.total_events} />
            <SummaryMetric label="Threads" value={data.summary.affected_threads} />
            <SummaryMetric label="Groups" value={data.summary.distinct_groups} />
            <SummaryMetric
              label="Latest"
              value={data.summary.latest_error_at ? formatDate(data.summary.latest_error_at) : '-'}
            />
          </div>

          <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className="overflow-hidden rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Error</TableHead>
                    <TableHead className="w-24 text-right">Events</TableHead>
                    <TableHead className="w-24 text-right">Threads</TableHead>
                    <TableHead className="w-44">Last seen</TableHead>
                    <TableHead className="w-28">Fingerprint</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.groups.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                        No chat errors in this window
                      </TableCell>
                    </TableRow>
                  ) : (
                    data.groups.map((group) => (
                      <TableRow
                        key={group.fingerprint}
                        className={cn(group.fingerprint === data.fingerprint && 'bg-muted/60')}
                      >
                        <TableCell className="min-w-0">
                          <Link
                            to={`/qaml-backdoor/errors?range=${data.range}&fingerprint=${encodeURIComponent(group.fingerprint)}`}
                            className="block min-w-0 hover:underline"
                          >
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="truncate font-medium">
                                  {group.message_sample}
                                </div>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-96">
                                {group.message_sample}
                              </TooltipContent>
                            </Tooltip>
                            <div className="mt-1 flex flex-wrap gap-1">
                              <ErrorMetaBadges group={group} />
                            </div>
                          </Link>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {group.count.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {group.affected_thread_count.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>{formatCompactAge(group.last_seen_at)}</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              first {formatDate(group.first_seen_at)}
                              <br />
                              last {formatDate(group.last_seen_at)}
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {shortFingerprint(group.fingerprint)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="min-h-80 overflow-hidden rounded-lg border bg-card">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">Affected Threads</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {selectedFingerprint ? shortFingerprint(selectedFingerprint) : 'Select an error group'}
                  </div>
                </div>
                <Bug className="size-4 text-muted-foreground" />
              </div>
              {selectedFingerprint ? (
                <div className="divide-y">
                  {data.threads.length === 0 ? (
                    <div className="p-6 text-center text-sm text-muted-foreground">
                      No affected threads found for this group
                    </div>
                  ) : (
                    data.threads.map((thread) => (
                      <div key={thread.thread_id} className="p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">
                              {thread.title || thread.thread_id}
                            </div>
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">
                              {thread.user_email ?? thread.user_id ?? 'unknown user'} ·{' '}
                              {thread.org_name ?? thread.org_id}
                            </div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {thread.count} occurrence{thread.count === 1 ? '' : 's'} · last{' '}
                              {formatDate(thread.last_seen_at)}
                            </div>
                          </div>
                          <Badge variant="outline" className="shrink-0">
                            {thread.count}
                          </Badge>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <Button asChild variant="outline" size="sm" className="h-7">
                            <Link
                              to={`/qaml-backdoor/chat-explorer?thread=${encodeURIComponent(thread.thread_id)}&errors=1`}
                            >
                              Chat Explorer
                            </Link>
                          </Button>
                          <Button asChild variant="ghost" size="sm" className="h-7">
                            <Link to={`/qaml-backdoor/threads/${encodeURIComponent(thread.thread_id)}`}>
                              Thread admin
                            </Link>
                          </Button>
                          <Button asChild variant="ghost" size="sm" className="h-7">
                            <Link to={`/qaml-backdoor/orgs/${encodeURIComponent(thread.org_id)}`}>
                              Org
                              <ExternalLink className="size-3" />
                            </Link>
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="flex min-h-80 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                  Select a grouped error to inspect affected threads.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function SummaryMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold tabular-nums">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

function ErrorMetaBadges({
  group,
}: {
  group: {
    source: string;
    error_kind: string | null;
    status: number | null;
    provider: string | null;
    model: string | null;
  };
}) {
  const values = [
    group.source,
    group.error_kind,
    group.status ? String(group.status) : null,
    group.provider,
    group.model,
  ].filter((value): value is string => Boolean(value));
  return (
    <>
      {values.map((value) => (
        <Badge key={value} variant="outline" className="h-5 max-w-36 px-1.5 text-[10px]">
          <span className="truncate">{value}</span>
        </Badge>
      ))}
    </>
  );
}

function formatDate(value: number): string {
  return dateFormatter.format(new Date(value));
}

function formatCompactAge(value: number): string {
  const diffMs = Date.now() - value;
  const absMs = Math.abs(diffMs);
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (absMs < hour) return `${Math.max(1, Math.round(absMs / 60_000))}m ago`;
  if (absMs < day) return `${Math.round(absMs / hour)}h ago`;
  return `${Math.round(absMs / day)}d ago`;
}

function shortFingerprint(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function getRangeHref(range: string, fingerprint: string | null): string {
  const params = new URLSearchParams({ range });
  if (fingerprint) params.set('fingerprint', fingerprint);
  return `/qaml-backdoor/errors?${params.toString()}`;
}
