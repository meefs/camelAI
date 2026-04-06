"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ForceOrphanDialog } from "@/components/admin/force-orphan-dialog";
import { DeleteUserDialog } from "@/components/admin/delete-user-dialog";
import { BanUserDialog } from "@/components/admin/ban-user-dialog";
import { Badge } from "@/components/ui/badge";
import type { BanRecord } from "../../../workers/main/src/ban-list";

interface UserAdminActionsProps {
  userId: string;
  userEmail: string;
  hasMemberships: boolean;
  isOrphaned: boolean;
  orgCount: number;
  userBan?: BanRecord | null;
}

export function UserAdminActions({
  userId,
  userEmail,
  hasMemberships,
  isOrphaned,
  orgCount,
  userBan,
}: UserAdminActionsProps) {
  const orphanDisabled = !hasMemberships || isOrphaned;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Danger Zone</CardTitle>
        <CardDescription>High-impact actions for this account</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="destructive">
          <AlertDescription>
            Ban + purge is the real abuse-handling path. Hard delete should only
            be used for test accounts.
          </AlertDescription>
        </Alert>
        {userBan ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">Active ban</span>
              <Badge variant="destructive">{userBan.purge_status}</Badge>
            </div>
            <p className="mt-2 text-muted-foreground">{userBan.reason}</p>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <BanUserDialog
            userId={userId}
            userEmail={userEmail}
            orgCount={orgCount}
            disabled={Boolean(userBan)}
          />
          <ForceOrphanDialog
            userId={userId}
            userLabel={userEmail}
            disabled={orphanDisabled || Boolean(userBan)}
          />
          <DeleteUserDialog
            userId={userId}
            userEmail={userEmail}
            orgCount={orgCount}
            disabled={Boolean(userBan)}
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
  );
}
