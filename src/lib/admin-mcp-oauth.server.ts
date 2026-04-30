import { AdminMcpOAuthProvider } from "../../workers/main/src/admin-mcp-oauth";
import type { CloudflareEnv } from "./cloudflare.server";

export {
  ADMIN_MCP_SCOPE,
  OAuthError,
  isAllowedOAuthRedirectUri,
} from "../../workers/main/src/admin-mcp-oauth";

export function parseAdminMcpRedirectUris(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getAdminMcpOAuth(env: CloudflareEnv): AdminMcpOAuthProvider {
  return new AdminMcpOAuthProvider(
    env.APP_KV,
    (env as any).ADMIN_MCP_CLIENT_ID,
    parseAdminMcpRedirectUris((env as any).ADMIN_MCP_REDIRECT_URIS),
  );
}

export function getAdminMcpResource(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/api/admin/mcp`;
}
