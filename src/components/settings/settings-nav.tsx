"use client"

import { Link, useLocation } from "react-router"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface NavItem {
  label: string
  href: string
  adminOnly?: boolean
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    label: "User",
    items: [
      { label: "Profile", href: "/settings/profile" },
      { label: "Organizations", href: "/settings/organizations" },
    ],
  },
  {
    label: "Organization",
    items: [
      { label: "General", href: "/settings/organization/general" },
      { label: "Team", href: "/settings/organization/team" },
      { label: "Workspaces", href: "/settings/organization/workspaces" },
      { label: "Billing", href: "/settings/organization/billing" },
      { label: "AI Provider", href: "/settings/organization/ai-provider", adminOnly: true },
      { label: "Experimental", href: "/settings/organization/experimental", adminOnly: true },
      { label: "Usage", href: "/settings/organization/usage" },
      { label: "Domains", href: "/settings/organization/domains" },
    ],
  },
  {
    label: "Workspace",
    items: [
      { label: "General", href: "/settings/workspace/general" },
      { label: "Connections", href: "/settings/workspace/connections", adminOnly: true },
      { label: "Chats", href: "/settings/workspace/chats", adminOnly: true },
      { label: "Apps", href: "/settings/workspace/apps", adminOnly: true },
    ],
  },
]

function NavLink({
  href,
  label,
  isActive,
}: {
  href: string
  label: string
  isActive: boolean
}) {
  return (
    <Button
      asChild
      variant="ghost"
      className={cn(
        "w-full justify-start",
        isActive && "bg-muted text-foreground"
      )}
    >
      <Link to={href}>{label}</Link>
    </Button>
  )
}

interface SettingsNavProps {
  isOrgAdmin?: boolean
}

export function SettingsNav({ isOrgAdmin }: SettingsNavProps) {
  const { pathname } = useLocation()

  const filteredGroups = navGroups.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.adminOnly || isOrgAdmin),
  }))

  return (
    <nav className="md:w-56 shrink-0">
      <div className="md:hidden px-4 py-3">
        <div className="flex gap-2 overflow-x-auto">
          {filteredGroups.flatMap((group) =>
            group.items.map((item) => {
              const isActive = pathname === item.href
              return (
                <Button
                  key={item.href}
                  asChild
                  variant={isActive ? "secondary" : "ghost"}
                  className="shrink-0"
                >
                  <Link to={item.href}>{item.label}</Link>
                </Button>
              )
            })
          )}
        </div>
      </div>
      <div className="hidden md:block p-4">
        <div className="space-y-6">
          {filteredGroups.map((group) => (
            <div key={group.label} className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground px-2 uppercase tracking-wide">
                {group.label}
              </p>
              {group.items.map((item) => (
                <NavLink
                  key={item.href}
                  href={item.href}
                  label={item.label}
                  isActive={pathname === item.href}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </nav>
  )
}
