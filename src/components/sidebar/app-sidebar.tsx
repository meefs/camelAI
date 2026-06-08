"use client"

import { useState } from "react"
import { AppWindowMac, Cable, CircleHelp, Clock, LayoutGrid, MessagesSquare, Plus } from "lucide-react"
import { Link, useLocation, useNavigate, useRevalidator } from "react-router"
import type { ChatGroupThreadSummary } from "@/types"

import { useAuthData } from "@/hooks/use-auth-data"
import {
  getCloseGroupRedirect,
  getGroupLandingHref,
  useChatGroups,
} from "@/hooks/use-chat-groups"
import { GetHelpDialog } from "@/components/get-help-dialog"
import { ChatGroupsList } from "@/components/sidebar/chat-groups-list"
import { NavUser } from "@/components/sidebar/nav-user"
import { WorkspaceSwitcher } from "@/components/sidebar/workspace-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"

// Temporarily hidden while the Computer tab fix is in progress.
const SHOW_COMPUTER_NAV_ITEM = false

type AppSidebarProps = React.ComponentProps<typeof Sidebar>;

export function AppSidebar(props: AppSidebarProps) {
  const [helpOpen, setHelpOpen] = useState(false)
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const revalidator = useRevalidator()
  const { currentWorkspace } = useAuthData()
  const { groups, activeGroupId, isLoading } = useChatGroups()
  const isHistory = pathname === "/history"
  const isConnections = pathname === "/connections"
  const isApps = pathname === "/apps"
  const isAutomations = pathname === "/automations"
  const isComputer = pathname.startsWith("/computer")
  const computerHref = currentWorkspace?.id
    ? `/computer/${currentWorkspace.id}`
    : "/computer"
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? null

  const handleCloseGroup = async (groupId: string) => {
    const redirect = getCloseGroupRedirect(groups, activeGroupId, groupId)
    if (redirect) {
      navigate(redirect, { replace: true })
    }
    await fetch(`/api/chat-groups/${encodeURIComponent(groupId)}`, {
      method: "DELETE",
    })
    revalidator.revalidate()
  }

  const handleMoveThreadToGroup = async (threadId: string, targetGroupId: string) => {
    if (activeGroup?.id === targetGroupId) return
    const response = await fetch("/api/chat-groups/move-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, targetGroupId }),
    })
    if (response.ok) {
      revalidator.revalidate()
      navigate(`/chat/${threadId}`)
    }
  }

  const handleSelectThreadFromHover = async (
    groupId: string,
    thread: ChatGroupThreadSummary,
  ) => {
    const href = `/chat/${encodeURIComponent(thread.id)}?group=${encodeURIComponent(groupId)}`
    if (thread.membership === "open") {
      navigate(href)
      return
    }

    try {
      const response = await fetch(
        `/api/chat-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(thread.id)}/reopen`,
        { method: "POST" },
      )
      if (!response.ok) {
        console.error("Failed to reopen chat group member", await response.text())
        return
      }
    } catch (error) {
      console.error("Failed to reopen chat group member", error)
      return
    }

    revalidator.revalidate()
    navigate(href)
  }

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="[--safe-area-padding-left:0.5rem] [--safe-area-padding-right:0.5rem] pl-safe pr-safe">
        <WorkspaceSwitcher />
      </SidebarHeader>
      <SidebarContent className="pl-safe pr-safe">
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="New chat"
                className="font-medium"
                onClick={() => navigate("/chat")}
              >
                <Plus />
                <span>New chat</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarMenu>
            {SHOW_COMPUTER_NAV_ITEM ? (
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Computer" isActive={isComputer}>
                  <Link to={computerHref}>
                    <AppWindowMac />
                    <span>Computer</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Chat History" isActive={isHistory}>
                <Link to="/history">
                  <MessagesSquare />
                  <span>Chat History</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Connections" isActive={isConnections}>
                <Link to="/connections">
                  <Cable />
                  <span>Connections</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Apps" isActive={isApps}>
                <Link to="/apps">
                  <LayoutGrid />
                  <span>Apps</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Automations" isActive={isAutomations}>
                <Link to="/automations">
                  <Clock />
                  <span>Automations</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Chat Groups</SidebarGroupLabel>
          <ChatGroupsList
            groups={groups}
            activeGroupId={activeGroupId}
            isLoading={isLoading}
            onSelectGroup={(groupId) => {
              const group = groups.find((entry) => entry.id === groupId)
              navigate(group ? getGroupLandingHref(group) : "/chat")
            }}
            onCloseGroup={handleCloseGroup}
            onSelectThread={handleSelectThreadFromHover}
            onMoveThreadToGroup={handleMoveThreadToGroup}
          />
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="[--safe-area-padding-left:0.5rem] [--safe-area-padding-right:0.5rem] [--safe-area-padding-bottom:0.5rem] pl-safe pr-safe pb-safe">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Get Help"
              onClick={() => setHelpOpen(true)}
            >
              <CircleHelp />
              <span>Get Help</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <NavUser />
      </SidebarFooter>
      <GetHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <SidebarRail />
    </Sidebar>
  )
}
