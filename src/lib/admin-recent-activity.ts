export function deriveCheapRecentCount(recentCount: number, limit: number): number | null {
  const normalizedRecentCount = Number.isFinite(recentCount)
    ? Math.max(0, Math.floor(recentCount))
    : 0;
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : 1;

  return normalizedRecentCount < normalizedLimit ? normalizedRecentCount : null;
}

export function deriveCheapRecentActivityCounts(params: {
  recentThreadCount: number;
  threadLimit: number;
  recentAppCount: number;
  appLimit: number;
}): {
  threadCount: number | null;
  appCount: number | null;
} {
  return {
    threadCount: deriveCheapRecentCount(params.recentThreadCount, params.threadLimit),
    appCount: deriveCheapRecentCount(params.recentAppCount, params.appLimit),
  };
}
