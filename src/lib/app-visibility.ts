export function buildSetAppPublicPayload({
  scriptName,
  isPublic,
  threadId,
}: {
  scriptName: string;
  isPublic: boolean;
  threadId?: string;
}) {
  return {
    intent: 'setAppPublic',
    scriptName,
    isPublic: String(isPublic),
    ...(threadId ? { threadId } : {}),
  };
}
