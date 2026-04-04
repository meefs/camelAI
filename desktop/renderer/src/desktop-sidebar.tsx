import {
  AppWindowMac,
  Cable,
  CircleHelp,
  Home,
  LayoutGrid,
  MessagesSquare,
  Plus,
  TerminalSquare,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import type { DesktopSnapshot, DesktopThread } from "../../shared/protocol";

interface DesktopSidebarProps {
  activeThreadId: string | null;
  connectionState: "connecting" | "open" | "closed";
  onCreateThread: () => void;
  onSelectThread: (threadId: string) => void;
  snapshot: DesktopSnapshot | null;
  threads: DesktopThread[];
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function authLabel(snapshot: DesktopSnapshot | null): string {
  if (!snapshot) {
    return "Checking auth";
  }
  if (!snapshot.auth.available) {
    return snapshot.auth.label;
  }
  return `${snapshot.model} via ${snapshot.auth.label}`;
}

function runtimeDetail(snapshot: DesktopSnapshot | null): string | null {
  if (!snapshot) {
    return null;
  }
  const detail = snapshot.runtimeStatus.detail?.trim();
  return detail || null;
}

function shouldShowRuntimeCard(snapshot: DesktopSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  return (
    snapshot.runtimeStatus.state !== "running" ||
    !snapshot.auth.available
  );
}

export function DesktopSidebar({
  activeThreadId,
  connectionState,
  onCreateThread,
  onSelectThread,
  snapshot,
  threads,
}: DesktopSidebarProps) {
  const { state } = useSidebar();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Local Workspace"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar size="default">
                <AvatarFallback content="CA">CA</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Local Workspace</span>
                <span className="truncate text-xs text-muted-foreground">
                  camelAI Desktop
                </span>
              </div>
              <TerminalSquare className="ml-auto size-4" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div
          className="flex px-2 transition-[justify-content] duration-200 ease-in-out"
          style={{
            justifyContent: state === "expanded" ? "flex-start" : "center",
          }}
        >
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
              <SidebarMenuButton tooltip="New Chat" isActive>
                <Home />
                <span>New Chat</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Computer" disabled>
                <AppWindowMac />
                <span>Computer</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Chat History" disabled>
                <MessagesSquare />
                <span>Chat History</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Connections" disabled>
                <Cable />
                <span>Connections</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Apps" disabled>
                <LayoutGrid />
                <span>Apps</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupLabel>Recent Chats</SidebarGroupLabel>
          <SidebarGroupAction
            aria-label="Create new thread"
            onClick={onCreateThread}
          >
            <Plus />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {threads.map((thread) => (
                <SidebarMenuItem key={thread.id}>
                  <SidebarMenuButton
                    size="lg"
                    isActive={thread.id === activeThreadId}
                    tooltip={thread.title}
                    onClick={() => onSelectThread(thread.id)}
                    className="h-auto min-h-12"
                  >
                    <MessagesSquare />
                    <div className="grid flex-1 min-w-0 text-left text-sm leading-tight">
                      <span className="truncate font-medium">
                        {thread.title}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {thread.lastMessagePreview ||
                          formatTime(thread.updatedAt)}
                      </span>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Get Help" disabled>
              <CircleHelp />
              <span>Get Help</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        {shouldShowRuntimeCard(snapshot) ? (
          <div className="px-2 pb-1 group-data-[collapsible=icon]:hidden">
            <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/40 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    snapshot?.runtimeStatus.state === "error"
                      ? "destructive"
                      : "outline"
                  }
                >
                  {snapshot
                    ? `Runtime ${snapshot.runtimeStatus.state}`
                    : "Runtime starting"}
                </Badge>
                <Badge
                  variant={connectionState === "open" ? "secondary" : "outline"}
                >
                  {connectionState === "open"
                    ? "backend connected"
                    : "connecting"}
                </Badge>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {authLabel(snapshot)}
              </p>
              {runtimeDetail(snapshot) ? (
                <p
                  className={`mt-2 text-xs leading-relaxed ${
                    snapshot?.runtimeStatus.state === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }`}
                  title={runtimeDetail(snapshot) ?? undefined}
                >
                  {runtimeDetail(snapshot)}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Local User"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar size="default">
                <AvatarFallback content="ME">ME</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Local User</span>
                <span className="truncate text-xs text-muted-foreground">
                  No login
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
