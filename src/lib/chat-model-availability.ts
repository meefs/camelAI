export function isNoModelsBlockingNewThread(
  threadId: string | null | undefined,
  noModelsMessage: string | null | undefined,
): boolean {
  return Boolean(noModelsMessage && !threadId);
}
