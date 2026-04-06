import type { Route } from "./+types/auth.switch-workspace";
import { getEnv, type CloudflareEnv } from "@/lib/cloudflare.server";
import {
  getSignedSessionFromRequest,
  createSessionCookieHeader,
} from "@/lib/cookies.server";
import { type AuthEnv } from "@/lib/auth-helpers";
import {
  getWorkspace,
  getWorkspaceAccess,
  switchSessionOrg,
  switchSessionWorkspace,
} from "@/lib/auth-do";
import { getBanForSessionIdentifiers } from "@/lib/ban.server";

function getAuthEnv(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv["USER"],
    ORG: env.ORG as AuthEnv["ORG"],
    WORKSPACE: env.WORKSPACE as AuthEnv["WORKSPACE"],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    APP_KV: env.APP_KV,
    TOKEN_SIGNING_SECRET: env.TOKEN_SIGNING_SECRET,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const env = getEnv(context);
    const authEnv = getAuthEnv(env);

    const session = await getSignedSessionFromRequest(
      request,
      env.TOKEN_SIGNING_SECRET,
    );
    if (!session) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }

    const existingBan = await getBanForSessionIdentifiers(context, {
      userId: session.user_id,
      userEmail: session.user_email,
      orgId: session.org_id,
    });
    if (existingBan) {
      return Response.json(
        { error: "This account has been blocked.", redirect: "/banned" },
        { status: 403 },
      );
    }

    const body = (await request.json()) as { workspaceId?: string };
    const { workspaceId } = body;

    if (!workspaceId) {
      return Response.json(
        { error: "Workspace ID is required" },
        { status: 400 },
      );
    }

    // Verify workspace access
    const accessLevel = await getWorkspaceAccess(
      authEnv,
      workspaceId,
      session.user_id,
    );
    if (accessLevel === "none") {
      return Response.json(
        { error: "No access to this workspace" },
        { status: 403 },
      );
    }

    // Get workspace to check its org
    const workspace = await getWorkspace(authEnv, workspaceId);
    if (!workspace) {
      return Response.json({ error: "Workspace not found" }, { status: 404 });
    }

    const nextOrgBan = await getBanForSessionIdentifiers(context, {
      orgId: workspace.org_id,
    });
    if (nextOrgBan) {
      return Response.json(
        { error: "This organization has been blocked.", redirect: "/banned" },
        { status: 403 },
      );
    }

    const currentSessionData = {
      user_id: session.user_id,
      org_id: session.org_id,
      workspace_id: session.workspace_id,
      created_at: session.created_at,
      last_accessed: session.created_at,
      user_name: session.user_name,
      user_email: session.user_email,
    };

    let signedToken: string;
    // If workspace is in a different org, switch org as well
    if (workspace.org_id !== session.org_id) {
      signedToken = await switchSessionOrg(
        authEnv,
        currentSessionData,
        workspace.org_id,
        workspaceId,
      );
    } else {
      signedToken = await switchSessionWorkspace(
        authEnv,
        currentSessionData,
        workspaceId,
      );
    }

    return Response.json(
      { success: true },
      {
        headers: {
          "Set-Cookie": createSessionCookieHeader(signedToken, request),
        },
      },
    );
  } catch (error) {
    console.error("Switch workspace error:", error);
    return Response.json(
      { error: "Failed to switch workspace" },
      { status: 500 },
    );
  }
}
