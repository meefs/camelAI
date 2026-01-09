"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const navGroups = [
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
      { label: "Domains", href: "/settings/organization/domains" },
    ],
  },
  {
    label: "Workspace",
    items: [
      { label: "General", href: "/settings/workspace/general" },
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
      <Link href={href}>{label}</Link>
    </Button>
  )
}

export function SettingsNav() {
  const pathname = usePathname()

  return (
    <nav className="md:w-56 shrink-0">
      <div className="md:hidden px-4 py-3">
        <div className="flex gap-2 overflow-x-auto">
          {navGroups.flatMap((group) =>
            group.items.map((item) => {
              const isActive = pathname === item.href
              return (
                <Button
                  key={item.href}
                  asChild
                  variant={isActive ? "secondary" : "ghost"}
                  className="shrink-0"
                >
                  <Link href={item.href}>{item.label}</Link>
                </Button>
              )
            })
          )}
        </div>
      </div>
      <div className="hidden md:block p-4">
        <div className="space-y-6">
          {navGroups.map((group) => (
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
