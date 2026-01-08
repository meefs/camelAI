"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ForceOrphanDialog } from "@/components/admin/force-orphan-dialog"

interface UserAdminActionsProps {
  userId: string
  userEmail: string
  hasMemberships: boolean
  isOrphaned: boolean
}

export function UserAdminActions({
  userId,
  userEmail,
  hasMemberships,
  isOrphaned,
}: UserAdminActionsProps) {
  const disabled = !hasMemberships || isOrphaned

  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin Actions</CardTitle>
        <CardDescription>High-impact actions for this account</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <ForceOrphanDialog
          userId={userId}
          userLabel={userEmail}
          disabled={disabled}
        />
        {disabled ? (
          <span className="text-xs text-muted-foreground">
            {isOrphaned
              ? "User is already orphaned."
              : "User has no organization memberships."}
          </span>
        ) : null}
      </CardContent>
    </Card>
  )
}
