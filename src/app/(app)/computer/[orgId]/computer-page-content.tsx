'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import type { SandboxFileListing } from '@/types';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, FileText, Folder, RefreshCw } from 'lucide-react';

interface ComputerPageContentProps {
  orgId: string;
}

const indentClasses = ['pl-0', 'pl-3', 'pl-6', 'pl-9', 'pl-12', 'pl-14', 'pl-16', 'pl-20'];

function formatBytes(size: number): string {
  if (!Number.isFinite(size)) return '0 B';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

export default function ComputerPageContent({ orgId }: ComputerPageContentProps) {
  const router = useRouter();
  const { user, currentOrg, loading: authLoading } = useAuth();
  const [listing, setListing] = useState<SandboxFileListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/computer/${orgId}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || 'Failed to load workspace files');
      }
      const data = (await res.json()) as SandboxFileListing;
      setListing(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspace files');
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login');
    }
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!authLoading && currentOrg?.id && currentOrg.id !== orgId) {
      router.push(`/computer/${currentOrg.id}`);
    }
  }, [authLoading, currentOrg?.id, orgId, router]);

  useEffect(() => {
    if (!authLoading && user) {
      fetchFiles();
    }
  }, [authLoading, user, fetchFiles]);

  const sortedFiles = useMemo(() => {
    if (!listing) return [];
    const visible = listing.files.filter((file) => file.relativePath && file.relativePath !== '.');
    return [...visible].sort((a, b) => {
      const parentA = a.relativePath.split('/').slice(0, -1).join('/');
      const parentB = b.relativePath.split('/').slice(0, -1).join('/');
      if (parentA === parentB && a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.relativePath.localeCompare(b.relativePath);
    });
  }, [listing]);

  const treeEntries = useMemo(() => {
    return sortedFiles.map((file) => {
      const depth = Math.min(file.relativePath.split('/').length - 1, indentClasses.length - 1);
      return { ...file, depth };
    });
  }, [sortedFiles]);

  const rawListing = useMemo(() => {
    if (!sortedFiles.length) return '';
    return sortedFiles
      .map((file) => (file.type === 'directory' ? `${file.relativePath}/` : file.relativePath))
      .join('\n');
  }, [sortedFiles]);

  const stats = useMemo(() => {
    if (!listing) {
      return { files: 0, directories: 0 };
    }
    return listing.files.reduce(
      (acc, file) => {
        if (file.type === 'directory') {
          acc.directories += 1;
        } else if (file.type === 'file') {
          acc.files += 1;
        }
        return acc;
      },
      { files: 0, directories: 0 }
    );
  }, [listing]);

  const snapshotLabel = listing?.timestamp
    ? new Date(listing.timestamp).toLocaleString()
    : null;
  const previewText = error
    ? 'Unable to load workspace listing.'
    : rawListing || 'No files to display yet.';

  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Computer' }]} />

      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold">Computer</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Browse the org workspace running inside your container.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  {currentOrg?.name ? currentOrg.name : `Org ${orgId}`}
                </Badge>
                {listing && (
                  <>
                    <Badge variant="secondary">{stats.directories} folders</Badge>
                    <Badge variant="secondary">{stats.files} files</Badge>
                  </>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={fetchFiles}
                  disabled={loading || authLoading || !user}
                >
                  <RefreshCw className="mr-2 size-4" />
                  Refresh
                </Button>
              </div>
            </div>

            {error && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircle className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <Card>
                <CardHeader>
                  <CardTitle>Workspace Tree</CardTitle>
                  <CardDescription>
                    {listing ? (
                      `${listing.count} entries from ${listing.path}`
                    ) : (
                      'Fetching workspace layout from the sandbox.'
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {loading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 10 }, (_, index) => (
                        <Skeleton key={index} className="h-4 w-full" />
                      ))}
                    </div>
                  ) : error ? (
                    <div className="py-10 text-center text-sm text-muted-foreground">
                      Unable to load workspace files.
                    </div>
                  ) : treeEntries.length === 0 ? (
                    <div className="py-10 text-center text-sm text-muted-foreground">
                      No files found in this workspace yet.
                    </div>
                  ) : (
                    <ScrollArea className="h-[420px] md:h-[520px]">
                      <div className="space-y-1 pr-3">
                        {treeEntries.map((file) => {
                          const Icon = file.type === 'directory' ? Folder : FileText;
                          const indent = indentClasses[file.depth] || 'pl-0';
                          return (
                            <div
                              key={file.relativePath}
                              className={`flex items-center gap-2 text-sm ${indent}`}
                            >
                              <div className="flex min-w-0 flex-1 items-center gap-2">
                                <Icon className="size-4 text-muted-foreground" />
                                <span className="truncate">
                                  {file.name}
                                  {file.type === 'directory' ? '/' : ''}
                                </span>
                              </div>
                              {file.type === 'file' && (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {formatBytes(file.size)}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Monaco Preview</CardTitle>
                  <CardDescription>
                    {snapshotLabel
                      ? `Snapshot captured ${snapshotLabel}. Monaco integration is coming next.`
                      : 'Monaco integration is coming next. Raw listing shown for now.'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {loading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 8 }, (_, index) => (
                        <Skeleton key={index} className="h-4 w-full" />
                      ))}
                    </div>
                  ) : (
                    <ScrollArea className="h-[420px] md:h-[520px]">
                      <pre className="whitespace-pre-wrap rounded-md bg-muted p-4 text-xs font-mono text-muted-foreground">
                        {previewText}
                      </pre>
                    </ScrollArea>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </ScrollArea>
      </div>
    </>
  );
}
