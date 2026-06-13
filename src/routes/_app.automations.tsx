import { useLoaderData } from "react-router";
import type { Route } from "./+types/_app.automations";
import { NoWorkspacesError } from "@/components/no-workspaces-error";
import AutomationsClient from "@/components/pages/automations/automations-client";
import { AutomationsLoadingSkeleton } from "@/components/pages/automations/automations-loading";
import { requireAuthContext, requireSessionWorkspaceAccess } from "@/lib/auth.server";
import {
  buildAutomationsPageData,
  mutateAutomation,
} from "@/lib/automations.server";
import type { AutomationKind } from "@/lib/automations-shared";

export function meta() {
  return [
    { title: "Automations - camelAI" },
    {
      name: "description",
      content: "Scheduled chats and workflows running on your behalf.",
    },
  ];
}

function parseKind(value: FormDataEntryValue | null): AutomationKind | null {
  return value === "agent_task" || value === "workflow" ? value : null;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { orgId, workspaceId, userId, access } =
    await requireSessionWorkspaceAccess(request, context, undefined, {
      requireWrite: true,
    });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const kind = parseKind(formData.get("kind"));
  const id = String(formData.get("id") ?? "").trim();

  if (!kind) return { error: "kind is required" };
  if (!id) return { error: "id is required" };

  try {
    return await mutateAutomation({
      context,
      workspaceId,
      orgId,
      userId,
      canManage: access === "full",
      intent,
      kind,
      id,
      name: String(formData.get("name") ?? ""),
      enabled:
        formData.has("enabled")
          ? String(formData.get("enabled")) === "true"
          : undefined,
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to update automation",
    };
  }
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const workspaceId = authContext.currentWorkspace?.id;
  const renderedAt = Date.now();

  if (!workspaceId) {
    return { hasWorkspace: false, automations: [], renderedAt };
  }
  const currentWorkspace = authContext.currentWorkspace;
  if (!currentWorkspace) {
    return { hasWorkspace: false, automations: [], renderedAt };
  }

  const data = await buildAutomationsPageData({
    context,
    workspaceId,
    orgId: authContext.currentOrg.id,
    userId: authContext.user.id,
    canManage: currentWorkspace.access_level === "full",
    request,
    currentUser: authContext.user,
  });

  return {
    hasWorkspace: true,
    ...data,
    renderedAt,
  };
}

export default function AutomationsPage() {
  const data = useLoaderData<typeof loader>();
  if (!data.hasWorkspace) {
    return <NoWorkspacesError />;
  }

  return (
    <AutomationsClient
      initialAutomations={data.automations}
      initialNow={data.renderedAt}
    />
  );
}

export function HydrateFallback() {
  return <AutomationsLoadingSkeleton />;
}
