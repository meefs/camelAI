"use client"

import { useEffect, useState } from "react"
import { useFetcher } from "react-router"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const [value, setValue] = useState<OrgRole>(currentRole)
  const [error, setError] = useState<string | null>(null)
  const isPending = fetcher.state !== "idle"
  const isOwner = currentRole === "owner"

  useEffect(() => {
    setValue(currentRole)
  }, [currentRole])

  // Handle response
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.error) {
        setValue(currentRole)
        setError(fetcher.data.error)
      } else {
        setError(null)
      }
    }
  }, [fetcher.state, fetcher.data, currentRole])

  const handleChange = (nextRole: string) => {
    const role = nextRole as OrgRole
    setValue(role)
    setError(null)
    fetcher.submit(
      { intent: "updateMemberRole", orgId, userId, role },
      { method: "POST" }
    )
  }

  if (isOwner) {
    return <span className="text-xs text-muted-foreground">Owner</span>
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
