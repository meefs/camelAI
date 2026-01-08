"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Pencil, PencilOff, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { setWorkspaceAccess } from "@/lib/server-actions/workspace"
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
  memberId,
  workspaces,
  accessByWorkspace,
  canEdit,
  editing = false,
  onAccessChange,
}: WorkspaceAccessTagsProps) {
  const [accessState, setAccessState] = useState(accessByWorkspace)

  useEffect(() => {
    setAccessState(accessByWorkspace)
  }, [accessByWorkspace])

  const { memberWorkspaces, hiddenWorkspaces } = useMemo(() => {
    const memberVisible: Array<{ workspace: Workspace; access: WorkspaceAccessLevel }> = []
    const hidden: Workspace[] = []

    for (const workspace of workspaces) {
      const access = accessState[workspace.id] ?? "full"
      if (access === "none") {
        hidden.push(workspace)
      } else {
        memberVisible.push({ workspace, access })
      }
    }

    return { memberWorkspaces: memberVisible, hiddenWorkspaces: hidden }
  }, [accessState, workspaces])

  const updateAccess = async (workspaceId: string, next: WorkspaceAccessLevel) => {
    const previous = accessState[workspaceId] ?? "full"
    setAccessState((prev) => ({ ...prev, [workspaceId]: next }))
    try {
      await setWorkspaceAccess(workspaceId, memberId, next)
      onAccessChange?.(workspaceId, next)
    } catch (error) {
      setAccessState((prev) => ({ ...prev, [workspaceId]: previous }))
      toast.error(
        error instanceof Error ? error.message : "Failed to update workspace access"
      )
    }
  }

  const handleToggle = (workspaceId: string, current: WorkspaceAccessLevel) => {
    const next = current === "full" ? "read_only" : "full"
    void updateAccess(workspaceId, next)
  }

  const handleRemove = (workspaceId: string) => {
    void updateAccess(workspaceId, "none")
  }

  const handleAdd = (workspaceId: string) => {
    void updateAccess(workspaceId, "full")
  }

  const showControls = canEdit && editing

  return (
    <div className="flex flex-wrap gap-1.5">
      {memberWorkspaces.map(({ workspace, access }) => (
        <div
          key={workspace.id}
          className={cn(
            "group relative inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs",
            access === "full"
              ? "bg-secondary text-secondary-foreground"
              : "bg-secondary/50 text-muted-foreground border border-dashed"
          )}
        >
          <span className="truncate max-w-[140px]">{workspace.name}</span>
          {showControls ? (
            <div className="flex items-center gap-0.5 ml-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => handleToggle(workspace.id, access)}
                    className="p-0.5 hover:bg-background rounded"
                  >
                    {access === "full" ? (
                      <Pencil className="h-3 w-3" />
                    ) : (
                      <PencilOff className="h-3 w-3" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {access === "full" ? "Make read-only" : "Grant full access"}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => handleRemove(workspace.id)}
                    className="p-0.5 hover:bg-background rounded"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Remove access</TooltipContent>
              </Tooltip>
            </div>
          ) : null}
        </div>
      ))}
      {showControls && hiddenWorkspaces.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-7">
              + Add
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {hiddenWorkspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                onClick={() => handleAdd(workspace.id)}
              >
                {workspace.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}
