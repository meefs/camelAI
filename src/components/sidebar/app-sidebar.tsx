"use client"

import { useState } from "react"
import { AppWindowMac, Cable, CircleHelp, Home, LayoutGrid, MessagesSquare } from "lucide-react"
import { Link, useLocation } from "react-router"

import { useAuthData } from "@/hooks/use-auth-data"
import { GetHelpDialog } from "@/components/get-help-dialog"
import { NavUser } from "@/components/sidebar/nav-user"
import { WorkspaceSwitcher } from "@/components/sidebar/workspace-switcher"
import { Badge } from "@/components/ui/badge"
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
  useSidebar,
} from "@/components/ui/sidebar"

type AppSidebarProps = React.ComponentProps<typeof Sidebar>;

export function AppSidebar(props: AppSidebarProps) {
  const [helpOpen, setHelpOpen] = useState(false)
  const { pathname } = useLocation()
  const { currentWorkspace } = useAuthData()
  const { state } = useSidebar()
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
        <div className="flex px-2 transition-[justify-content] duration-200 ease-in-out" style={{ justifyContent: state === "expanded" ? "flex-start" : "center" }}>
          <Badge
            variant="secondary"
            className="text-[10px] tracking-wider font-semibold uppercase"
          >
            Beta
          </Badge>
        </div>
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
