"use client"

import { useEffect, useRef, useState } from "react"
import { useFetcher } from "react-router"
import { toast } from "sonner"
import { Link } from "react-router"
import { CircleAlert, Folder, MoreHorizontal, Plus, ShieldAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { CreateWorkspaceDialog } from "@/components/settings/create-workspace-dialog"
import { useSwitchWorkspace } from "@/hooks/use-auth-actions"
import { getContrastTextColor } from "@/lib/avatar"

type ComputeTier = "standard" | "pro" | "enterprise"

interface WorkspaceSummary {
  id: string
  org_id: string
  name: string
  description: string | null
  created_at: number
  avatar: {
    color: string
    content: string
  }
  member_count: number
  published_apps: number
  compute_tier: ComputeTier
}

interface WorkspacesListProps {
  workspaces: WorkspaceSummary[]
  canManage: boolean
  currentWorkspaceId: string | null
  orgWorkspaceCount?: number
}

function formatDate(value: number) {
  return new Date(value).toLocaleDateString()
}

const computeLabels: Record<ComputeTier, string> = {
  standard: "Standard",
  pro: "Pro",
  enterprise: "Enterprise",
}

export function WorkspacesList({
  workspaces,
  canManage,
  currentWorkspaceId,
  orgWorkspaceCount,
}: WorkspacesListProps) {
  const { switchWorkspace } = useSwitchWorkspace()
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const [createOpen, setCreateOpen] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<WorkspaceSummary | null>(null)
  const pendingArchiveRef = useRef<string | null>(null)

  // Handle fetcher response for archive
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success && pendingArchiveRef.current) {
        const archivedId = pendingArchiveRef.current
        pendingArchiveRef.current = null
        setArchiveTarget(null)
        toast.success("Workspace archived")
        // Switch to another workspace if the current one was archived
        if (archivedId === currentWorkspaceId) {
          const fallback = workspaces.find((ws) => ws.id !== archivedId)
          if (fallback) {
            switchWorkspace(fallback.id)
          }
          // React Router will auto-revalidate after the fetcher action
        }
      } else if (fetcher.data.error) {
        pendingArchiveRef.current = null
        toast.error(fetcher.data.error)
      }
    }
  }, [fetcher.state, fetcher.data, currentWorkspaceId, workspaces, switchWorkspace])

  const handleSwitch = (workspaceId: string) => {
    switchWorkspace(workspaceId)
    toast.success("Switching workspace...")
  }

  const handleArchive = (workspaceId: string) => {
    pendingArchiveRef.current = workspaceId
    fetcher.submit(
      { intent: "archiveWorkspace", workspaceId },
      { method: "POST" }
    )
  }

  // Empty state when no workspaces are accessible
  const isAccessDenied = workspaces.length === 0 && (orgWorkspaceCount ?? 0) > 0
  if (workspaces.length === 0) {
    const Icon = isAccessDenied ? ShieldAlert : CircleAlert
    return (
      <div className="space-y-6">
        {canManage && !isAccessDenied && (
          <div className="flex justify-end">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 size-4" />
              Create workspace
            </Button>
          </div>
        )}

        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="rounded-full bg-destructive/10 p-4 mb-4">
            <Icon className="h-8 w-8 text-destructive" />
          </div>
          <h3 className="text-lg font-medium text-foreground mb-1">
            {isAccessDenied ? "Workspace Access Denied" : "No workspaces"}
          </h3>
          <p className="text-sm text-muted-foreground max-w-sm mb-6">
            {isAccessDenied
              ? canManage
                ? "There are workspaces in this organization, but you are not assigned to any of them. Assign yourself access in the Team tab."
                : "You don't have access to any workspaces in this organization. Ask an organization admin to grant you workspace access."
              : "A workspace is required to use camelAI. Without a workspace, you cannot create chats, set up connections, or deploy apps."}
          </p>

          <div className="flex flex-col items-center gap-3">
            {canManage && isAccessDenied && (
              <Button asChild>
                <Link to="/settings/organization/team">
                  Assign yourself access
                </Link>
              </Button>
            )}
            {canManage && !isAccessDenied && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 size-4" />
                Create workspace
              </Button>
            )}
          </div>
        </div>

        <CreateWorkspaceDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {canManage ? (
        <div className="flex justify-end">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 size-4" />
            Create workspace
          </Button>
        </div>
      ) : null}

      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workspace</TableHead>
              <TableHead>Members</TableHead>
              <TableHead>Compute</TableHead>
              <TableHead>Apps</TableHead>
              <TableHead>Created</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workspaces.map((workspace) => (
              <TableRow
                key={workspace.id}
                className={workspace.id === currentWorkspaceId ? "bg-muted/50" : ""}
              >
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar size="default">
                      <AvatarFallback
                        content={workspace.avatar.content}
                        style={{
                          backgroundColor: workspace.avatar.color,
                          color: getContrastTextColor(workspace.avatar.color),
                        }}
                      >
                        {workspace.avatar.content}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">{workspace.name}</p>
                      {workspace.description ? (
                        <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                          {workspace.description}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {workspace.member_count} members
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">
                    {computeLabels[workspace.compute_tier]}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {workspace.published_apps} apps
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDate(workspace.created_at)}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[180px]">
                      <DropdownMenuItem
                        onClick={() => handleSwitch(workspace.id)}
                        className="whitespace-nowrap"
                      >
                        Switch to this workspace
                      </DropdownMenuItem>
                      {canManage ? (
                        <DropdownMenuItem
                          onClick={() => setArchiveTarget(workspace)}
                          className="whitespace-nowrap text-destructive"
                        >
                          Archive workspace
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-3 md:hidden">
        {workspaces.map((workspace) => (
          <Card key={workspace.id}>
            <CardHeader className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <Avatar size="default">
                    <AvatarFallback
                      content={workspace.avatar.content}
                      style={{
                        backgroundColor: workspace.avatar.color,
                        color: getContrastTextColor(workspace.avatar.color),
                      }}
                    >
                      {workspace.avatar.content}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <CardTitle className="text-sm">{workspace.name}</CardTitle>
                    {workspace.description ? (
                      <p className="text-xs text-muted-foreground">
                        {workspace.description}
                      </p>
                    ) : null}
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon">
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[180px]">
                    <DropdownMenuItem
                      onClick={() => handleSwitch(workspace.id)}
                      className="whitespace-nowrap"
                    >
                      Switch to this workspace
                    </DropdownMenuItem>
                    {canManage ? (
                      <DropdownMenuItem
                        onClick={() => setArchiveTarget(workspace)}
                        className="whitespace-nowrap text-destructive"
                      >
                        Archive workspace
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">
                  {computeLabels[workspace.compute_tier]}
                </Badge>
                <span>{workspace.member_count} members</span>
                <span>{workspace.published_apps} apps</span>
              </div>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Created {formatDate(workspace.created_at)}
            </CardContent>
          </Card>
        ))}
      </div>

      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(null)
        }}
        title="Archive workspace?"
        description="This action cannot be undone. The workspace will be archived."
        confirmLabel="Archive workspace"
        variant="destructive"
        onConfirm={() => {
          if (archiveTarget) {
            void handleArchive(archiveTarget.id)
          }
        }}
      />
    </div>
  )
}
