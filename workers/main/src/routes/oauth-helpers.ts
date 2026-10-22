import { safeRedirectPath } from "../../../../src/lib/safe-redirect";

export function sanitizeOAuthRedirectPath(input: string): string {
  return safeRedirectPath(input, "/connections");
}
