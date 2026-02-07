"use client"

import { useMemo } from "react"
import { X } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getContrastTextColor } from "@/lib/avatar"
import type { Workspace, WorkspaceAccessLevel } from "@/types"

interface WorkspaceAccessTagsProps {
  memberId: string
  workspaces: Workspace[]
  accessByWorkspace: Record<string, WorkspaceAccessLevel>
  canEdit: boolean
  editing?: boolean
  onAccessChange?: (workspaceId: string, access: WorkspaceAccessLevel) => void
}

export function WorkspaceAccessTags({
  workspaces,
  accessByWorkspace,
  canEdit,
  editing = false,
  onAccessChange,
}: WorkspaceAccessTagsProps) {
  const { memberWorkspaces, hiddenWorkspaces } = useMemo(() => {
    const memberVisible: Array<{ workspace: Workspace; access: WorkspaceAccessLevel }> = []
    const hidden: Workspace[] = []

    for (const workspace of workspaces) {
      const access = accessByWorkspace[workspace.id] ?? "full"
      if (access === "none") {
        hidden.push(workspace)
      } else {
        memberVisible.push({ workspace, access })
      }
    }

    return { memberWorkspaces: memberVisible, hiddenWorkspaces: hidden }
  }, [accessByWorkspace, workspaces])

  const handleRemove = (workspaceId: string) => {
    onAccessChange?.(workspaceId, "none")
  }

  const handleAdd = (workspaceId: string) => {
    onAccessChange?.(workspaceId, "full")
  }

  const showControls = canEdit && editing

  return (
    <div className="flex flex-wrap gap-1.5">
      {memberWorkspaces.map(({ workspace }) => (
        <div
          key={workspace.id}
          className="group relative inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs bg-secondary text-secondary-foreground"
        >
          <span className="truncate max-w-[140px]">{workspace.name}</span>
          {showControls ? (
            <button
              type="button"
              onClick={() => handleRemove(workspace.id)}
              className="p-0.5 hover:bg-background rounded"
              title="Remove access"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      ))}
      {showControls ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              disabled={hiddenWorkspaces.length === 0}
            >
              + Add
            </Button>
          </DropdownMenuTrigger>
          {hiddenWorkspaces.length > 0 ? (
            <DropdownMenuContent align="start" className="min-w-[180px]">
              {hiddenWorkspaces.map((workspace) => (
                <DropdownMenuItem
                  key={workspace.id}
                  onClick={() => handleAdd(workspace.id)}
                  className="whitespace-nowrap gap-2"
                >
                  <Avatar size="sm">
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
                  <span className="truncate">{workspace.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          ) : null}
        </DropdownMenu>
      ) : null}
    </div>
  )
}
