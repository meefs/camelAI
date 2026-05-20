export function formatHoverRelativeTime(
  timestamp: number,
  now: number = Date.now(),
): string {
  const diff = Math.max(0, now - timestamp);
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);

  if (seconds < 45) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function formatRunningElapsed(
  startedAt: number,
  now: number = Date.now(),
): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${String(remainingMinutes).padStart(2, "0")}m`;
}
