"use client"

import { Check, ChevronsUpDown } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
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
import { Skeleton } from "@/components/ui/skeleton"
import { useAuth } from "@/contexts/AuthContext"
import { getContrastTextColor } from "@/lib/avatar"

function WorkspaceSwitcherSkeleton() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" asChild>
          <div aria-hidden="true" className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex-1 space-y-1 group-data-[collapsible=icon]:hidden">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-4 w-4 rounded group-data-[collapsible=icon]:hidden" />
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

export function WorkspaceSwitcher() {
  const { isMobile } = useSidebar()
  const { currentOrg, currentWorkspace, workspaces, orgs, switchWorkspace, loading } = useAuth()
  const workspaceList = workspaces ?? []
  const orgNameById = new Map(orgs.map((org) => [org.org_id, org.org_name]))

  if (loading && !currentWorkspace) {
    return <WorkspaceSwitcherSkeleton />
  }

  if (!currentOrg) {
    return null
  }

  if (!currentWorkspace) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" disabled>
            <Avatar size="default">
              <AvatarFallback content="?">?</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium text-muted-foreground">
                No workspace
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {currentOrg.name}
              </span>
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar size="default">
                <AvatarFallback
                  content={currentWorkspace.avatar.content}
                  style={{
                    backgroundColor: currentWorkspace.avatar.color,
                    color: getContrastTextColor(currentWorkspace.avatar.color),
                  }}
                >
                  {currentWorkspace.avatar.content}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{currentWorkspace.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {currentOrg.name}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto" />
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
            {workspaceList.map((workspace) => {
              // Always show org name for all workspaces
              const orgName =
                orgNameById.get(workspace.org_id) ??
                (workspace.org_id === currentOrg?.id ? currentOrg.name : null)

              return (
                <DropdownMenuItem
                  key={workspace.id}
                  onClick={() => switchWorkspace(workspace.id)}
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
                      {workspace.access_level === "read_only" ? (
                        <Badge variant="secondary" className="shrink-0 text-[10px]">
                          Read-only
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  {workspace.id === currentWorkspace.id ? (
                    <Check className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : null}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
