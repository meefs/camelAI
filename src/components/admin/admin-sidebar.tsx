'use client';

import {
  Building2,
  FolderKanban,
  Home,
  Mail,
  MessageSquare,
  Rocket,
  Terminal,
  Users,
} from 'lucide-react';
import { Link } from 'react-router';
import { useLocation } from 'react-router';

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';

const adminRoutes = [
  {
    label: 'Dashboard',
    href: '/qaml-backdoor',
    icon: Home,
  },
];

const modelRoutes = [
  {
    label: 'Users',
    href: '/qaml-backdoor/users',
    icon: Users,
  },
  {
    label: 'Organizations',
    href: '/qaml-backdoor/orgs',
    icon: Building2,
  },
  {
    label: 'Workspaces',
    href: '/qaml-backdoor/workspaces',
    icon: FolderKanban,
  },
  {
    label: 'Threads',
    href: '/qaml-backdoor/threads',
    icon: MessageSquare,
  },
  {
    label: 'Apps',
    href: '/qaml-backdoor/apps',
    icon: Rocket,
  },
  {
    label: 'Logs',
    href: '/qaml-backdoor/logs',
    icon: Terminal,
  },
  {
    label: 'Invitations',
    href: '/qaml-backdoor/invitations',
    icon: Mail,
  },
];

type AdminSidebarProps = React.ComponentProps<typeof Sidebar>;

export function AdminSidebar(props: AdminSidebarProps) {
  const { pathname } = useLocation();

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-semibold text-sm">
            Q
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">QAML Backdoor</span>
            <span className="truncate text-xs text-muted-foreground">Admin Panel</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {adminRoutes.map((route) => (
              <SidebarMenuItem key={route.href}>
                <SidebarMenuButton
                  asChild
                  tooltip={route.label}
                  isActive={pathname === route.href}
                >
                  <Link to={route.href}>
                    <route.icon />
                    <span>{route.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Models</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {modelRoutes.map((route) => (
                <SidebarMenuItem key={route.href}>
                  <SidebarMenuButton
                    asChild
                    tooltip={route.label}
                    isActive={pathname.startsWith(route.href)}
                  >
                    <Link to={route.href}>
                      <route.icon />
                      <span>{route.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
