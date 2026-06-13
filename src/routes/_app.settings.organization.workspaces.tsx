import { useLoaderData } from "react-router";
import type { Route } from "./+types/_app.settings.organization.workspaces";
import {
  requireAuthContext,
  requireOrgAdmin,
  getAuthEnv,
} from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import {
  createWorkspace,
  archiveWorkspace,
  listOrgWorkspaces,
} from "@/lib/auth-do";
import { Separator } from "@/components/ui/separator";
import { SettingsHeader } from "@/components/settings/settings-header";
import { WorkspacesList } from "@/components/settings/workspaces-list";

type WorkspaceSummaryCounts = {
  workspaceId: string;
  memberCount: number;
  publishedApps: number;
};

export function meta() {
  return [
    { title: "Workspaces - Settings - camelAI" },
    { name: "description", content: "Manage workspaces" },
  ];
}

function isMissingRpcMethodError(error: unknown, methodName: string): boolean {
  return (
    error instanceof TypeError &&
    (error.message.includes(`does not implement "${methodName}"`) ||
      error.message.includes(`${methodName} is not a function`) ||
      error.message.includes(`.${methodName} is not a function`))
  );
}

async function loadWorkspaceSummaryCounts(
  env: ReturnType<typeof getEnv>,
  orgStub: ReturnType<ReturnType<typeof getAuthEnv>["ORG"]["get"]>,
  workspaceIds: string[],
): Promise<WorkspaceSummaryCounts[]> {
  try {
    return await (
      orgStub as unknown as {
        getWorkspaceSummaryCounts(
          workspaceIds: string[],
        ): Promise<WorkspaceSummaryCounts[]>;
      }
    ).getWorkspaceSummaryCounts(workspaceIds);
  } catch (error) {
    if (!isMissingRpcMethodError(error, "getWorkspaceSummaryCounts")) {
      throw error;
    }
  }

  const scripts = await orgStub.listWorkerScripts();
  const appCountMap = new Map<string, number>();
  for (const script of scripts) {
    appCountMap.set(
      script.workspace_id,
      (appCountMap.get(script.workspace_id) ?? 0) + 1,
    );
  }

  return Promise.all(
    workspaceIds.map(async (workspaceId) => {
      const workspaceStub = env.WORKSPACE.get(
        env.WORKSPACE.idFromName(workspaceId),
      );
      const members = await workspaceStub.listMembers();
      return {
        workspaceId,
        memberCount: members.filter((member) => member.access_level !== "none")
          .length,
        publishedApps: appCountMap.get(workspaceId) ?? 0,
      };
    }),
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgId = authContext.currentOrg!.id;
  const actorId = authContext.user!.id;

  if (intent === "createWorkspace") {
    const name = formData.get("name") as string;
    const description = formData.get("description") as string;
    if (!name?.trim()) {
      return { error: "Workspace name is required" };
    }
    try {
      await createWorkspace(
        authEnv,
        orgId,
        name.trim(),
        actorId,
        description?.trim() || null,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes("already exists")) {
        return {
          error:
            "A workspace with that name already exists in this organization",
        };
      }
      if (err instanceof Error && err.message.includes("billing plan")) {
        return { error: err.message };
      }
      throw err;
    }
    return { success: true };
  }

  if (intent === "archiveWorkspace") {
    const workspaceId = formData.get("workspaceId") as string;
    if (!workspaceId) {
      return { error: "Workspace ID is required" };
    }
    await archiveWorkspace(authEnv, workspaceId, actorId);
    return { success: true };
  }

  return { error: "Unknown action" };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  // Determine current user's role for permission gating
  const currentUserOrg = authContext.orgs.find(
    (o) => o.org_id === authContext.currentOrg.id,
  );
  const currentUserRole = currentUserOrg?.role ?? "member";
  const canManage = currentUserRole === "owner" || currentUserRole === "admin";

  const orgStub = authEnv.ORG.get(
    authEnv.ORG.idFromName(authContext.currentOrg.id),
  );

  const workspaces = authContext.workspaces ?? [];
  const summaryCounts = await loadWorkspaceSummaryCounts(
    env,
    orgStub,
    workspaces.map((ws) => ws.id),
  );
  const summaryCountMap = new Map(
    summaryCounts.map((counts) => [counts.workspaceId, counts]),
  );

  // Build WorkspaceSummary objects
  const workspaceSummaries = workspaces.map((ws) => ({
    id: ws.id,
    org_id: ws.org_id,
    name: ws.name,
    description: ws.description,
    created_at: ws.created_at,
    avatar: ws.avatar,
    member_count: summaryCountMap.get(ws.id)?.memberCount ?? 0,
    published_apps: summaryCountMap.get(ws.id)?.publishedApps ?? 0,
    compute_tier: ws.compute_tier ?? "standard",
  }));

  // When user has no accessible workspaces, check if the org actually has workspaces
  let orgWorkspaceCount = workspaceSummaries.length;
  if (workspaceSummaries.length === 0) {
    const allOrgWorkspaces = await listOrgWorkspaces(
      authEnv,
      authContext.currentOrg.id,
    );
    orgWorkspaceCount = allOrgWorkspaces.length;
  }

  return {
    org: authContext.currentOrg,
    workspaces: workspaceSummaries,
    currentWorkspaceId: authContext.currentWorkspace?.id,
    canManage,
    orgWorkspaceCount,
  };
}

export default function WorkspacesPage() {
  const { org, workspaces, currentWorkspaceId, canManage, orgWorkspaceCount } =
    useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Workspaces"
        description="Manage workspaces in your organization."
      />
      <Separator />
      <WorkspacesList
        workspaces={workspaces}
        canManage={canManage}
        currentWorkspaceId={currentWorkspaceId ?? null}
        orgWorkspaceCount={orgWorkspaceCount}
      />
    </div>
  );
}
