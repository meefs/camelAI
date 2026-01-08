"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { updateAdminOrgMemberRole } from "@/lib/server-actions/admin"
import type { OrgRole } from "@/types"

const ROLE_OPTIONS: OrgRole[] = ["admin", "member", "viewer"]

interface OrgMemberRoleSelectProps {
  orgId: string
  userId: string
  currentRole: OrgRole
  disabled?: boolean
}

export function OrgMemberRoleSelect({
  orgId,
  userId,
  currentRole,
  disabled = false,
}: OrgMemberRoleSelectProps) {
  if (currentRole === "owner") {
    return <span className="text-xs text-muted-foreground">Owner</span>
  }

  const router = useRouter()
  const [value, setValue] = useState<OrgRole>(currentRole)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    setValue(currentRole)
  }, [currentRole])

  const handleChange = (nextRole: string) => {
    const role = nextRole as OrgRole
    setValue(role)
    setError(null)
    startTransition(async () => {
      try {
        await updateAdminOrgMemberRole(orgId, userId, role)
        router.refresh()
      } catch (err) {
        setValue(currentRole)
        setError(err instanceof Error ? err.message : "Failed to update role")
      }
    })
  }

  return (
    <div className="space-y-1">
      <Select
        value={value}
        onValueChange={handleChange}
        disabled={disabled || isPending}
      >
        <SelectTrigger className="h-8 w-[140px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLE_OPTIONS.map((role) => (
            <SelectItem key={role} value={role}>
              {role}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
