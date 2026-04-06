import { Link, useLoaderData, redirect } from "react-router";
import type { Route } from "./+types/_admin.orgs.$id";
import { requireSuperuser, getAuthEnv } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import * as adminDO from "@/lib/auth-do.server";
import {
  adminTransferOrgOwnership,
  updateOrgMemberRole,
  getOrg,
  getOrgMembers,
  getOrgInvitations,
} from "@/lib/auth-do";
import { getOrgBanById, type BanRecord } from "../../workers/main/src/ban-list";
import { waitUntil } from "@/lib/wait-until";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AddOrgMemberDialog } from "@/components/admin/add-org-member-dialog";
import { OrgDangerZone } from "@/components/admin/org-danger-zone";
import { OrgMemberRoleSelect } from "@/components/admin/org-member-role-select";
import { OrgEditForm } from "@/components/admin/org-edit-form";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getContrastTextColor } from "@/lib/avatar";
import { cn } from "@/lib/utils";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

const RECENT_THREAD_LIMIT = 10;
const RECENT_APP_LIMIT = 10;

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

const roleBadgeClasses: Record<string, string> = {
  owner: "border-amber-500/30 bg-amber-500/15 text-amber-700",
  admin: "border-blue-500/30 bg-blue-500/15 text-blue-700",
  member: "border-slate-500/30 bg-slate-500/10 text-slate-700",
  viewer: "border-muted bg-muted text-muted-foreground",
};

export function meta({ data }: Route.MetaArgs) {
  return [
    {
      title: data?.org
        ? `${data.org.name} - Admin - camelAI`
        : "Organization - Admin - camelAI",
    },
    { name: "description", content: "View organization details" },
  ];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const { id } = params;
  const authEnv = getAuthEnv(getEnv(context));

  // Fetch org first to check existence, then fetch related data in parallel
  const org = await getOrg(authEnv, id);
  if (!org) {
    throw redirect("/qaml-backdoor/orgs");
  }

  const env = getEnv(context);

  // Fetch usage data from sandbox-host (best-effort, don't block on failure)
  const usagePromise = env.SANDBOX_HOST
    ? Promise.all([
        env.SANDBOX_HOST.fetch(
          `http://sandbox/v1/usage/orgs/${encodeURIComponent(id)}/spend`,
        )
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        env.SANDBOX_HOST.fetch(
          `http://sandbox/v1/usage/orgs/${encodeURIComponent(id)}/log?limit=10`,
        )
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ])
    : Promise.resolve([null, null]);

  const [
    members,
    invitations,
    workspaces,
    recentActivity,
    [usageSpend, usageLog],
    orgBan,
  ] = await Promise.all([
    getOrgMembers(authEnv, id),
    getOrgInvitations(authEnv, id),
    adminDO.adminGetWorkspacesByOrg(context, id),
    adminDO.adminGetOrgRecentActivity(context, id, {
      threadLimit: RECENT_THREAD_LIMIT,
      appLimit: RECENT_APP_LIMIT,
      includeCounts: "cheap",
    }),
    usagePromise as Promise<[any, any]>,
    getOrgBanById(getEnv(context).APP_KV, id),
  ]);

  const threadCountFromWorkspaces = workspaces.reduce((sum, workspace) => {
    return (
      sum +
      (Number.isFinite(workspace.thread_count) ? workspace.thread_count : 0)
    );
  }, 0);
  const derivedThreadCount = Number.isFinite(threadCountFromWorkspaces)
    ? threadCountFromWorkspaces
    : recentActivity.threadCount;

  // Create plain object for Client Component
  const safeOrg = {
    id: org.id,
    name: org.name,
    slug: org.slug,
    created_by: org.created_by,
    created_at: org.created_at,
    billing_status: org.billing_status,
    archived: org.archived,
    archived_at: org.archived_at,
    archived_by: org.archived_by ?? null,
  };

  const memberOptions = members.map((member) => ({
    id: member.user.id,
    name: member.user.name,
    email: member.user.email,
    role: member.role,
  }));

  return {
    org: safeOrg,
    members,
    invitations,
    workspaces,
    recentThreads: recentActivity.threads,
    recentApps: recentActivity.apps,
    threadCount: derivedThreadCount,
    appCount: recentActivity.appCount,
    memberOptions,
    orgBan,
    usageSpend: usageSpend as {
      org_id: string;
      total_cost_usd: number;
      total_requests: number;
      windows: Array<{
        label: string;
        window_ms: number;
        limit_usd: number;
        spent_usd: number;
        exceeded: boolean;
      }>;
    } | null,
    usageLog: usageLog as {
      entries: Array<{
        id: number;
        model: string;
        provider: string;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number;
        duration_ms: number;
        created_at_ms: number;
      }>;
    } | null,
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  await requireSuperuser(request, context);

  const formData = await request.formData();
  const intent = formData.get("intent");
  const { id: orgId } = params;
  const authEnv = getAuthEnv(getEnv(context));

  if (intent === "addMember") {
    const userId = formData.get("userId") as string;
    const role = formData.get("role") as "admin" | "member";
    if (!userId || !role) {
      return { error: "User ID and role are required" };
    }
    await adminDO.addAdminOrgMember(context, orgId, userId, role);
    return { success: true };
  }

  if (intent === "updateMemberRole") {
    const userId = formData.get("userId") as string;
    const role = formData.get("role") as
      | "admin"
      | "member"
      | "viewer"
      | "owner";
    if (!userId || !role) {
      return { error: "User ID and role are required" };
    }
    await updateOrgMemberRole(authEnv, orgId, userId, role, "system-admin");
    return { success: true };
  }

  if (intent === "transferOwnership") {
    const newOwnerId = formData.get("newOwnerId") as string;
    if (!newOwnerId) {
      return { error: "New owner ID is required" };
    }
    await adminTransferOrgOwnership(authEnv, orgId, newOwnerId, "system-admin");
    return { success: true };
  }

  if (intent === "archiveOrg") {
    const stub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    await stub.archiveOrg("system-admin");
    return { success: true };
  }

  if (intent === "banOrg") {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      return { error: "Ban reason is required" };
    }
    try {
      const job = await adminDO.startAdminOrgBanAndPurgeWithEnv(
        getEnv(context),
        orgId,
        {
          reason,
          actorId: "system-admin",
        },
      );
      waitUntil(
        adminDO
          .runAdminOrgBanAndPurgeWithEnv(getEnv(context), job, "system-admin")
          .catch((error) => {
            console.error("[admin] org ban purge failed", error);
          }),
      );
      return { success: true, banStarted: true, jobId: job.id };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Failed to ban organization",
      };
    }
  }

  if (intent === "hardDeleteOrg") {
    try {
      const result = await adminDO.hardDeleteAdminOrg(
        context,
        orgId,
        "system-admin",
      );
      return { success: true, warnings: result.warnings };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Failed to permanently delete organization",
      };
    }
  }

  if (intent === "updateOrg") {
    const name = formData.get("name") as string;
    if (!name?.trim()) {
      return { error: "Organization name is required" };
    }
    const stub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    await stub.updateName(name.trim(), "system-admin");
    return { success: true };
  }

  return { error: "Unknown action" };
}

export default function AdminOrgDetailPage() {
  const {
    org,
    members,
    invitations,
    workspaces,
    recentThreads,
    recentApps,
    threadCount,
    appCount,
    memberOptions,
    orgBan,
    usageSpend,
    usageLog,
  } = useLoaderData<typeof loader>();
  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: "Admin", href: "/qaml-backdoor" },
          { label: "Organizations", href: "/qaml-backdoor/orgs" },
          { label: org.name },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-4xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Organization Details</CardTitle>
                <CardDescription>
                  View and edit organization information
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      ID
                    </dt>
                    <dd className="font-mono text-sm">{org.id}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Name
                    </dt>
                    <dd className="text-sm">{org.name}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Billing
                    </dt>
                    <dd>
                      <Badge
                        variant={
                          org.billing_status === "paying"
                            ? "default"
                            : "outline"
                        }
                      >
                        {org.billing_status === "paying" ? "Paying" : "Free"}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Status
                    </dt>
                    <dd>
                      <Badge variant={org.archived ? "secondary" : "outline"}>
                        {org.archived ? "Archived" : "Active"}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Created
                    </dt>
                    <dd className="text-sm">
                      {formatTimestamp(org.created_at)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Created By
                    </dt>
                    <dd>
                      <Link
                        to={`/qaml-backdoor/users/${org.created_by}`}
                        className="text-sm font-mono hover:underline"
                      >
                        {org.created_by.slice(0, 8)}...
                      </Link>
                    </dd>
                  </div>
                  {org.archived && org.archived_at ? (
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">
                        Archived At
                      </dt>
                      <dd className="text-sm">
                        {formatTimestamp(org.archived_at)}
                      </dd>
                    </div>
                  ) : null}
                  {org.archived && org.archived_by ? (
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">
                        Archived By
                      </dt>
                      <dd>
                        <Link
                          to={`/qaml-backdoor/users/${org.archived_by}`}
                          className="text-sm font-mono hover:underline"
                        >
                          {org.archived_by.slice(0, 8)}...
                        </Link>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Edit Organization</CardTitle>
                <CardDescription>Update organization settings</CardDescription>
              </CardHeader>
              <CardContent>
                <OrgEditForm org={org} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>AI Usage &amp; Spend</CardTitle>
                <CardDescription>
                  {usageSpend
                    ? `$${usageSpend.total_cost_usd.toFixed(2)} lifetime spend across ${usageSpend.total_requests} requests`
                    : "Usage tracking unavailable"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {usageSpend ? (
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      {usageSpend.windows.map((w) => (
                        <div
                          key={w.label}
                          className={cn(
                            "rounded-lg border p-3",
                            w.exceeded
                              ? "border-destructive/50 bg-destructive/5"
                              : "border-border",
                          )}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium">
                              {w.label} window
                            </span>
                            {w.exceeded ? (
                              <Badge variant="destructive">Exceeded</Badge>
                            ) : (
                              <Badge variant="outline">OK</Badge>
                            )}
                          </div>
                          <div className="text-lg font-semibold">
                            ${w.spent_usd.toFixed(2)}{" "}
                            <span className="text-sm font-normal text-muted-foreground">
                              / ${w.limit_usd.toFixed(0)}
                            </span>
                          </div>
                          <div className="mt-1.5 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all",
                                w.exceeded ? "bg-destructive" : "bg-primary",
                              )}
                              style={{
                                width: `${Math.min(100, (w.spent_usd / w.limit_usd) * 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>

                    {usageLog && usageLog.entries.length > 0 ? (
                      <div>
                        <p className="text-sm font-medium text-muted-foreground mb-2">
                          Recent requests
                        </p>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Model</TableHead>
                              <TableHead>Tokens</TableHead>
                              <TableHead>Cost</TableHead>
                              <TableHead>Time</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {usageLog.entries.map((entry) => (
                              <TableRow key={entry.id}>
                                <TableCell className="font-mono text-xs">
                                  {entry.model
                                    .replace("claude-", "")
                                    .replace(/-\d{8}$/, "")}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {entry.input_tokens.toLocaleString()} in /{" "}
                                  {entry.output_tokens.toLocaleString()} out
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                  ${entry.cost_usd.toFixed(4)}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {formatTimestamp(entry.created_at_ms)}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Sandbox host is not reachable or usage tracking is not
                    enabled.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Workspaces</CardTitle>
                <CardDescription>
                  {workspaces.length}{" "}
                  {workspaces.length === 1 ? "workspace" : "workspaces"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {workspaces.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No workspaces</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Workspace</TableHead>
                        <TableHead>Threads</TableHead>
                        <TableHead>Integrations</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workspaces.map((workspace) => (
                        <TableRow key={workspace.id}>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/workspaces/${workspace.id}`}
                              className="flex items-center gap-3 hover:underline"
                            >
                              <Avatar size="default">
                                <AvatarFallback
                                  content={workspace.avatar.content}
                                  style={{
                                    backgroundColor: workspace.avatar.color,
                                    color: getContrastTextColor(
                                      workspace.avatar.color,
                                    ),
                                  }}
                                >
                                  {workspace.avatar.content}
                                </AvatarFallback>
                              </Avatar>
                              <div>
                                <div className="font-medium">
                                  {workspace.name}
                                </div>
                                <div className="text-xs text-muted-foreground font-mono">
                                  {workspace.id.slice(0, 8)}...
                                </div>
                              </div>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {workspace.thread_count}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {workspace.integration_count}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                workspace.archived ? "secondary" : "outline"
                              }
                            >
                              {workspace.archived ? "Archived" : "Active"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent Threads</CardTitle>
                <CardDescription>
                  {threadCount === null
                    ? `${recentThreads.length} recent ${recentThreads.length === 1 ? "thread" : "threads"}`
                    : `${threadCount} total ${threadCount === 1 ? "thread" : "threads"} (showing latest ${recentThreads.length})`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {recentThreads.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No threads</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Thread</TableHead>
                        <TableHead>Workspace</TableHead>
                        <TableHead>Updated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentThreads.map((thread) => (
                        <TableRow key={thread.id}>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/threads/${thread.id}`}
                              className="hover:underline"
                            >
                              <div className="font-medium">
                                {thread.title || "Untitled"}
                              </div>
                              <div className="text-xs text-muted-foreground font-mono">
                                {thread.id.slice(0, 8)}...
                              </div>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/workspaces/${thread.workspace_id}`}
                              className="text-sm hover:underline"
                            >
                              {thread.workspace_name || thread.workspace_id}
                            </Link>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatTimestamp(thread.updated_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent Apps</CardTitle>
                <CardDescription>
                  {appCount === null
                    ? `${recentApps.length} recent ${recentApps.length === 1 ? "app" : "apps"}`
                    : `${appCount} total ${appCount === 1 ? "app" : "apps"} (showing latest ${recentApps.length})`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {recentApps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No apps</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>App</TableHead>
                        <TableHead>Workspace</TableHead>
                        <TableHead>Visibility</TableHead>
                        <TableHead>Updated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentApps.map((app) => (
                        <TableRow key={app.script_name}>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/apps/${encodeURIComponent(app.script_name)}`}
                              className="hover:underline font-mono"
                            >
                              {app.script_name}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/workspaces/${app.workspace_id}`}
                              className="text-sm hover:underline"
                            >
                              {app.workspace_name || app.workspace_id}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={app.is_public ? "default" : "secondary"}
                            >
                              {app.is_public ? "Public" : "Private"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatTimestamp(app.updated_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle>Members</CardTitle>
                  <CardDescription>
                    {members.length}{" "}
                    {members.length === 1 ? "member" : "members"}
                  </CardDescription>
                </div>
                <AddOrgMemberDialog orgId={org.id} />
              </CardHeader>
              <CardContent>
                {members.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No members</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Member</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Joined</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {members.map((member) => (
                        <TableRow key={member.user.id}>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/users/${member.user.id}`}
                              className="flex items-center gap-3 hover:underline"
                            >
                              <Avatar size="default">
                                <AvatarFallback
                                  content={member.user.avatar.content}
                                  style={{
                                    backgroundColor: member.user.avatar.color,
                                    color: getContrastTextColor(
                                      member.user.avatar.color,
                                    ),
                                  }}
                                >
                                  {member.user.avatar.content}
                                </AvatarFallback>
                              </Avatar>
                              <div>
                                <div className="font-medium">
                                  {member.user.name || member.user.email}
                                </div>
                                {member.user.name ? (
                                  <div className="text-xs text-muted-foreground">
                                    {member.user.email}
                                  </div>
                                ) : null}
                              </div>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={cn(
                                roleBadgeClasses[member.role] || "",
                              )}
                            >
                              {member.role}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatTimestamp(member.joined_at)}
                          </TableCell>
                          <TableCell>
                            <OrgMemberRoleSelect
                              orgId={org.id}
                              userId={member.user.id}
                              currentRole={member.role}
                              disabled={member.role === "owner"}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {invitations.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Pending Invitations</CardTitle>
                  <CardDescription>
                    {invitations.length} pending{" "}
                    {invitations.length === 1 ? "invitation" : "invitations"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Email</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Expires</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invitations.map((inv) => (
                        <TableRow key={inv.id}>
                          <TableCell>
                            <div className="font-medium">{inv.email}</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {inv.id.slice(0, 8)}...
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{inv.role}</Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatTimestamp(inv.expires_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Audit Log</CardTitle>
                <CardDescription>
                  Track recent organization changes
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="outline">
                  <Link to={`/qaml-backdoor/orgs/${org.id}/audit-log`}>
                    View Audit Log
                  </Link>
                </Button>
              </CardContent>
            </Card>

            <OrgDangerZone
              orgId={org.id}
              orgName={org.name}
              archived={org.archived}
              members={memberOptions}
              workspaceCount={workspaces.length}
              orgBan={orgBan as BanRecord | null}
            />
          </div>
        </div>
      </div>
    </>
  );
}
