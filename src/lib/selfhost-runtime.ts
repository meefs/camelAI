export interface SelfhostRuntimeEnv {
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
}

export function isSelfhostRuntime(env: SelfhostRuntimeEnv): boolean {
  return (
    env.CF_ACCOUNT_ID?.trim().toLowerCase() === "selfhost" ||
    env.CF_DISPATCH_NAMESPACE?.trim().toLowerCase() === "selfhost"
  );
}
