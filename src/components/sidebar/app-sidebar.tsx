"use client"

import { AppWindowMac, Cable, Home, LayoutGrid, MessagesSquare } from "lucide-react"
import { Link, useLocation } from "react-router"

import { useAuthData } from "@/hooks/use-auth-data"
import { NavUser } from "@/components/sidebar/nav-user"
import { WorkspaceSwitcher } from "@/components/sidebar/workspace-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"

type AppSidebarProps = React.ComponentProps<typeof Sidebar>;

export function AppSidebar(props: AppSidebarProps) {
  const { pathname } = useLocation()
  const { currentWorkspace } = useAuthData()
  const isHome = pathname === "/"
  const isHistory = pathname === "/history"
  const isConnections = pathname === "/connections"
  const isApps = pathname === "/apps"
  const isComputer = pathname.startsWith("/computer")
  const computerHref = currentWorkspace?.id
    ? `/computer/${currentWorkspace.id}`
    : "/computer"

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <WorkspaceSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="New Chat" isActive={isHome}>
                <Link to="/">
                  <Home />
                  <span>New Chat</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Computer" isActive={isComputer}>
                <Link to={computerHref}>
                  <AppWindowMac />
                  <span>Computer</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
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
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
