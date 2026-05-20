"use client"

import { useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { Check, ChevronsUpDown, CircleAlert, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useAuthData } from "@/hooks/use-auth-data"
import { useSwitchWorkspace } from "@/hooks/use-auth-actions"
import { getContrastTextColor } from "@/lib/avatar"

export function WorkspaceSwitcher() {
  const { isMobile } = useSidebar()
  const { currentOrg, currentWorkspace, allWorkspaces, orgs } = useAuthData()
  const { switchWorkspace, isSwitching } = useSwitchWorkspace()
  const navigate = useNavigate()
  const location = useLocation()
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null)
  const workspaceList = allWorkspaces ?? []
  const orgNameById = new Map(orgs.map((org) => [org.org_id, org.org_name]))

  if (!currentOrg) {
    return null
  }

  const handleSwitchWorkspace = async (workspaceId: string) => {
    if (workspaceId === currentWorkspace?.id || isSwitching) return

    setPendingWorkspaceId(workspaceId)
    try {
      await switchWorkspace(workspaceId)
      if (location.pathname.startsWith("/chat/")) {
        navigate("/chat")
      } else if (
        location.pathname === "/computer" ||
        location.pathname.startsWith("/computer/")
      ) {
        navigate(`/computer/${workspaceId}`)
      }
    } catch (error) {
      console.error("Failed to switch workspace:", error)
      toast.error("Failed to switch workspace")
    } finally {
      setPendingWorkspaceId(null)
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              disabled={isSwitching}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar size="default">
                {currentWorkspace ? (
                  <AvatarFallback
                    content={currentWorkspace.avatar.content}
                    style={{
                      backgroundColor: currentWorkspace.avatar.color,
                      color: getContrastTextColor(currentWorkspace.avatar.color),
                    }}
                  >
                    {currentWorkspace.avatar.content}
                  </AvatarFallback>
                ) : (
                  <AvatarFallback content="?">?</AvatarFallback>
                )}
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span
                  className={
                    currentWorkspace
                      ? "truncate font-medium"
                      : "truncate font-medium text-muted-foreground"
                  }
                >
                  {currentWorkspace?.name ?? "No workspace"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {currentOrg.name}
                </span>
              </div>
              {isSwitching ? (
                <Loader2 className="ml-auto animate-spin" />
              ) : (
                <ChevronsUpDown className="ml-auto" />
              )}
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-60 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Workspaces
            </DropdownMenuLabel>
            {workspaceList.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-4 px-3 text-center">
                <CircleAlert className="h-5 w-5 text-destructive" />
                <p className="text-sm text-muted-foreground">
                  No workspaces available
                </p>
              </div>
            ) : (
              workspaceList.map((workspace) => {
                const orgName =
                  orgNameById.get(workspace.org_id) ??
                  (workspace.org_id === currentOrg.id ? currentOrg.name : null)
                const isCurrent = workspace.id === currentWorkspace?.id
                const isPending = workspace.id === pendingWorkspaceId

                return (
                  <DropdownMenuItem
                    key={workspace.id}
                    disabled={isSwitching || isCurrent}
                    onClick={() => void handleSwitchWorkspace(workspace.id)}
                    className="gap-2 p-2"
                  >
                    <Avatar size="md" className="shrink-0">
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
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{workspace.name}</span>
                      <div className="flex items-center gap-1">
                        {orgName ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {orgName}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {isPending ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : isCurrent ? (
                      <Check className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : null}
                  </DropdownMenuItem>
                )
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
