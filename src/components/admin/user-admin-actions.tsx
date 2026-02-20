"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ForceOrphanDialog } from "@/components/admin/force-orphan-dialog"
import { DeleteUserDialog } from "@/components/admin/delete-user-dialog"

interface UserAdminActionsProps {
  userId: string
  userEmail: string
  hasMemberships: boolean
  isOrphaned: boolean
  orgCount: number
}

export function UserAdminActions({
  userId,
  userEmail,
  hasMemberships,
  isOrphaned,
  orgCount,
}: UserAdminActionsProps) {
  const orphanDisabled = !hasMemberships || isOrphaned

  return (
    <Card>
      <CardHeader>
        <CardTitle>Danger Zone</CardTitle>
        <CardDescription>High-impact actions for this account</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="destructive">
          <AlertDescription>
            Hard delete should only be used for test accounts. If you need to remove a real user&apos;s
            access, use Force Orphan instead.
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap items-center gap-3">
          <ForceOrphanDialog
            userId={userId}
            userLabel={userEmail}
            disabled={orphanDisabled}
          />
          <DeleteUserDialog
            userId={userId}
            userEmail={userEmail}
            orgCount={orgCount}
          />
          {orphanDisabled ? (
            <span className="text-xs text-muted-foreground">
              {isOrphaned
                ? "User is already orphaned."
                : "User has no organization memberships."}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
