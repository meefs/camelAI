import { Link, useLoaderData } from "react-router";
import { redirect } from "react-router";
import type { Route } from "./+types/_admin.users.$id";
import { requireSuperuser, getAuthEnv } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import * as adminDO from "@/lib/auth-do.server";
import {
  adminForceOrphanUser,
  adminUpdateUser,
  getUserOrgs,
  listUserWorkspacesAcrossOrgs,
} from "@/lib/auth-do";
import {
  getUserBanById,
  type BanRecord,
} from "../../workers/main/src/ban-list";
import { waitUntil } from "@/lib/wait-until";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { UserAdminActions } from "@/components/admin/user-admin-actions";
import { UserEditForm } from "@/components/admin/user-edit-form";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
      title: data?.user
        ? `${data.user.email} - Admin - camelAI`
        : "User - Admin - camelAI",
    },
    { name: "description", content: "View user details" },
  ];
}

export async function action({ request, context, params }: Route.ActionArgs) {
  await requireSuperuser(request, context);

  const formData = await request.formData();
  const intent = formData.get("intent");
  const { id: userId } = params;
  const authEnv = getAuthEnv(getEnv(context));

  if (intent === "forceOrphan") {
    await adminForceOrphanUser(authEnv, userId, "system-admin");
    return { success: true };
  }

  if (intent === "banUser") {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) {
      return { error: "Ban reason is required" };
    }
    try {
      const job = await adminDO.startAdminUserBanAndPurgeWithEnv(
        getEnv(context),
        userId,
        {
          reason,
          actorId: "system-admin",
        },
      );
      waitUntil(
        adminDO
          .runAdminUserBanAndPurgeWithEnv(getEnv(context), job, "system-admin")
          .catch((error) => {
            console.error("[admin] user ban purge failed", error);
          }),
      );
      return { success: true, banStarted: true, jobId: job.id };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Failed to ban user",
      };
    }
  }

  if (intent === "hardDeleteUser") {
    try {
      const result = await adminDO.hardDeleteAdminUser(
        context,
        userId,
        "system-admin",
      );
      return { success: true, warnings: result.warnings };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Failed to permanently delete user",
      };
    }
  }

  if (intent === "updateUser") {
    const name = formData.get("name") as string;
    const avatarColor = formData.get("avatarColor") as string;
    const avatarContent = formData.get("avatarContent") as string;
    const isSuperuser = formData.get("isSuperuser");
    await adminUpdateUser(authEnv, userId, {
      name: name?.trim() || null,
      avatar:
        avatarColor && avatarContent
          ? { color: avatarColor, content: avatarContent }
          : undefined,
      is_superuser: isSuperuser === "true",
    });
    return { success: true };
  }

  return { error: "Unknown action" };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const { id } = params;
  const authEnv = getAuthEnv(getEnv(context));

  // Fetch user and orgs in parallel
  const [user, orgs, userBan] = await Promise.all([
    authEnv.USER.get(authEnv.USER.idFromName(id)).getProfile(),
    getUserOrgs(authEnv, id),
    getUserBanById(getEnv(context).APP_KV, id),
  ]);

  if (!user) {
    throw redirect("/qaml-backdoor/users");
  }

  // Create plain object for Client Component
  const safeUser = {
    id: user.id,
    email: user.email,
    email_verified_at: user.email_verified_at,
    name: user.name,
    created_at: user.created_at,
    is_superuser: user.is_superuser,
    avatar: user.avatar,
    is_orphaned: user.is_orphaned,
    orphaned_at: user.orphaned_at,
  };

  const workspaces = await listUserWorkspacesAcrossOrgs(authEnv, id, orgs);
  const workspacesByOrg = new Map<string, typeof workspaces>();
  for (const workspace of workspaces) {
    const list = workspacesByOrg.get(workspace.org_id) ?? [];
    list.push(workspace);
    workspacesByOrg.set(workspace.org_id, list);
  }
  const orgNameById = new Map(orgs.map((org) => [org.org_id, org.org_name]));

  return {
    user: safeUser,
    orgs,
    workspaces,
    workspacesByOrg: Object.fromEntries(workspacesByOrg),
    orgNameById: Object.fromEntries(orgNameById),
    userBan,
  };
}

export default function AdminUserDetailPage() {
  const { user, orgs, workspaces, workspacesByOrg, orgNameById, userBan } =
    useLoaderData<typeof loader>();

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: "Admin", href: "/qaml-backdoor" },
          { label: "Users", href: "/qaml-backdoor/users" },
          { label: user.email },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-4xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>User Details</CardTitle>
                <CardDescription>
                  View and edit user information
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      ID
                    </dt>
                    <dd className="font-mono text-sm">{user.id}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Avatar
                    </dt>
                    <dd className="mt-1">
                      <Avatar size="xl">
                        <AvatarFallback
                          content={user.avatar.content}
                          style={{
                            backgroundColor: user.avatar.color,
                            color: getContrastTextColor(user.avatar.color),
                          }}
                        >
                          {user.avatar.content}
                        </AvatarFallback>
                      </Avatar>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Email
                    </dt>
                    <dd className="text-sm">{user.email}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Created
                    </dt>
                    <dd className="text-sm">
                      {formatTimestamp(user.created_at)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Email Verified
                    </dt>
                    <dd className="text-sm">
                      {user.email_verified_at
                        ? formatTimestamp(user.email_verified_at)
                        : "No"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Role
                    </dt>
                    <dd>
                      {user.is_superuser ? (
                        <Badge>Superuser</Badge>
                      ) : (
                        <Badge variant="outline">Standard</Badge>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Orphaned
                    </dt>
                    <dd>
                      {user.is_orphaned ? (
                        <Badge variant="destructive">Yes</Badge>
                      ) : (
                        <Badge variant="outline">No</Badge>
                      )}
                    </dd>
                  </div>
                  {user.orphaned_at ? (
                    <div>
                      <dt className="text-sm font-medium text-muted-foreground">
                        Orphaned At
                      </dt>
                      <dd className="text-sm">
                        {formatTimestamp(user.orphaned_at)}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Edit User</CardTitle>
                <CardDescription>
                  Update user name, avatar, and permissions
                </CardDescription>
              </CardHeader>
              <CardContent>
                <UserEditForm user={user} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Organization Memberships</CardTitle>
                <CardDescription>
                  {orgs.length}{" "}
                  {orgs.length === 1 ? "organization" : "organizations"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {orgs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No organizations
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Organization</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Workspace Access</TableHead>
                        <TableHead>Joined</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orgs.map((org) => {
                        const orgWorkspaces = workspacesByOrg[org.org_id] ?? [];
                        return (
                          <TableRow key={org.org_id}>
                            <TableCell>
                              <Link
                                to={`/qaml-backdoor/orgs/${org.org_id}`}
                                className="hover:underline"
                              >
                                <div className="font-medium">
                                  {org.org_name}
                                </div>
                                <div className="text-xs text-muted-foreground font-mono">
                                  {org.org_id.slice(0, 8)}...
                                </div>
                              </Link>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={cn(roleBadgeClasses[org.role] || "")}
                              >
                                {org.role}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {orgWorkspaces.length === 0 ? (
                                <span className="text-xs text-muted-foreground">
                                  None
                                </span>
                              ) : (
                                <div className="flex flex-wrap gap-1.5">
                                  {orgWorkspaces.map(
                                    (workspace: {
                                      id: string;
                                      name: string;
                                      access_level: string;
                                    }) => (
                                      <Badge
                                        key={workspace.id}
                                        variant="secondary"
                                        className=""
                                      >
                                        {workspace.name}
                                      </Badge>
                                    ),
                                  )}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatTimestamp(org.joined_at)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Workspace Access</CardTitle>
                <CardDescription>
                  {workspaces.length}{" "}
                  {workspaces.length === 1 ? "workspace" : "workspaces"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {workspaces.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No workspace access
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Workspace</TableHead>
                        <TableHead>Organization</TableHead>
                        <TableHead>Access Level</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workspaces.map((workspace) => (
                        <TableRow key={workspace.id}>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/workspaces/${workspace.id}`}
                              className="hover:underline"
                            >
                              <div className="font-medium">
                                {workspace.name}
                              </div>
                              <div className="text-xs text-muted-foreground font-mono">
                                {workspace.id.slice(0, 8)}...
                              </div>
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Link
                              to={`/qaml-backdoor/orgs/${workspace.org_id}`}
                              className="text-sm hover:underline"
                            >
                              {orgNameById[workspace.org_id] ??
                                workspace.org_id}
                            </Link>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {workspace.access_level === "none"
                                ? "None"
                                : "Full"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <UserAdminActions
              userId={user.id}
              userEmail={user.email}
              hasMemberships={orgs.length > 0}
              isOrphaned={user.is_orphaned}
              orgCount={orgs.length}
              userBan={userBan as BanRecord | null}
            />
          </div>
        </div>
      </div>
    </>
  );
}
