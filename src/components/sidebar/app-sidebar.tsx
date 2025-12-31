"use client"

import { AppWindowMac, Cable, Home, MessagesSquare } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { useAuth } from "@/contexts/AuthContext"
import { NavUser } from "@/components/sidebar/nav-user"
import { TeamSwitcher } from "@/components/sidebar/team-switcher"
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
  const pathname = usePathname()
  const { currentOrg } = useAuth()
  const isHome = pathname === "/"
  const isHistory = pathname === "/history"
  const isConnections = pathname === "/connections"
  const isComputer = pathname.startsWith("/computer")
  const computerHref = currentOrg?.id ? `/computer/${currentOrg.id}` : "/computer"

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="New Chat" isActive={isHome}>
                <Link href="/">
                  <Home />
                  <span>New Chat</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Chat History" isActive={isHistory}>
                <Link href="/history">
                  <MessagesSquare />
                  <span>Chat History</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Connections" isActive={isConnections}>
                <Link href="/connections">
                  <Cable />
                  <span>Connections</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Computer" isActive={isComputer}>
                <Link href={computerHref}>
                  <AppWindowMac />
                  <span>Computer</span>
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
