import type { Route } from "./+types/automations.$id.runs";
import { requireSessionWorkspaceAccess } from "@/lib/auth.server";
import { listAutomationRunsPageData } from "@/lib/automations.server";
import type { AutomationKind } from "@/lib/automations-shared";

function parseKind(value: string | null): AutomationKind | null {
  return value === "agent_task" || value === "workflow" ? value : null;
}

/**
 * Read-only, keyset-paginated run history for a single automation. Backs the
 * panel's "Previous runs" list and its "Show older runs" pagination so the
 * page loader does not have to fan out run history across every automation.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const automationId = params.id?.trim();
    if (!automationId) {
      return Response.json({ error: "Automation id required" }, { status: 400 });
    }

    const url = new URL(request.url);
    const kind = parseKind(url.searchParams.get("kind"));
    if (!kind) {
      return Response.json({ error: "kind is required" }, { status: 400 });
    }

    // Viewing run history only needs read access; the panel's mutating
    // controls gate on can_manage separately.
    const { workspaceId } = await requireSessionWorkspaceAccess(request, context);

    const cursor = url.searchParams.get("cursor");
    const limitParam = url.searchParams.get("limit");
    const limit =
      limitParam && Number.isFinite(Number(limitParam))
        ? Number(limitParam)
        : undefined;

    const page = await listAutomationRunsPageData({
      context,
      workspaceId,
      kind,
      automationId,
      cursor,
      limit,
    });
    return Response.json(page);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error("[automations] Failed to load run history page", error);
    return Response.json(
      { error: "Failed to load run history" },
      { status: 500 },
    );
  }
}
