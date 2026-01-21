"use client"

import { useEffect, useState } from "react"
import { useNavigate } from 'react-router';
import { toast } from "sonner"
import { MoreHorizontal, Plus } from "lucide-react"

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
import { useAuth } from "@/contexts/AuthContext"
import { archiveWorkspace } from "@/lib/server-actions/workspace"
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
}: WorkspacesListProps) {
  const navigate = useNavigate()
  const { refreshAuth, switchWorkspace } = useAuth()
  const [createOpen, setCreateOpen] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<WorkspaceSummary | null>(null)
  const [workspaceList, setWorkspaceList] = useState(workspaces)

  useEffect(() => {
    setWorkspaceList(workspaces)
  }, [workspaces])

  const handleSwitch = async (workspaceId: string) => {
    try {
      await switchWorkspace(workspaceId)
      // TODO: implement refresh
      toast.success("Switched workspace")
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to switch workspace"
      )
    }
  }

  const handleArchive = async (workspaceId: string) => {
    const fallback = workspaceList.find((workspace) => workspace.id !== workspaceId)

    try {
      await archiveWorkspace(workspaceId)
      setArchiveTarget(null)
      setWorkspaceList((prev) =>
        prev.filter((workspace) => workspace.id !== workspaceId)
      )

      if (workspaceId === currentWorkspaceId) {
        if (fallback) {
          await switchWorkspace(fallback.id)
        }
      }

      await refreshAuth()
      // TODO: implement refresh
      toast.success("Workspace archived")
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to archive workspace"
      )
    }
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
            {workspaceList.map((workspace) => (
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
        {workspaceList.map((workspace) => (
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
        onCreated={() => {
          refreshAuth()
          // TODO: implement refresh
        }}
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
