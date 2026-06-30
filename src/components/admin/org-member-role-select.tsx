"use client"

import { useLayoutEffect, useState } from "react"
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
  if (currentRole === "owner") {
    return <span className="text-xs text-muted-foreground">Owner</span>
  }

  return (
    <OrgMemberRoleSelectEditor
      key={`${userId}:${currentRole}`}
      orgId={orgId}
      userId={userId}
      currentRole={currentRole}
      disabled={disabled}
    />
  )
}

function OrgMemberRoleSelectEditor({
  orgId,
  userId,
  currentRole,
  disabled = false,
}: OrgMemberRoleSelectProps) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const [selection, setSelection] = useState<{
    value: OrgRole
    error: string | null
  }>(() => ({ value: currentRole, error: null }))
  const isPending = fetcher.state !== "idle"

  // Handle response
  useLayoutEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.error) {
        setSelection({ value: currentRole, error: fetcher.data.error })
      } else {
        setSelection((prev) => ({ ...prev, error: null }))
      }
    }
  }, [fetcher.state, fetcher.data, currentRole])

  const handleChange = (nextRole: string) => {
    const role = nextRole as OrgRole
    setSelection({ value: role, error: null })
    fetcher.submit(
      { intent: "updateMemberRole", orgId, userId, role },
      { method: "POST" }
    )
  }

  return (
    <div className="space-y-1">
      <Select
        value={selection.value}
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
      {selection.error ? (
        <p className="text-xs text-destructive">{selection.error}</p>
      ) : null}
    </div>
  )
}
