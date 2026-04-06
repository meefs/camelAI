"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArchiveOrgDialog } from "@/components/admin/archive-org-dialog";
import { TransferOwnershipDialog } from "@/components/admin/transfer-ownership-dialog";
import { DeleteOrgDialog } from "@/components/admin/delete-org-dialog";
import { BanOrgDialog } from "@/components/admin/ban-org-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import type { OrgRole } from "@/types";
import type { BanRecord } from "../../../workers/main/src/ban-list";

interface OrgMemberOption {
  id: string;
  name: string | null;
  email: string;
  role: OrgRole;
}

interface OrgDangerZoneProps {
  orgId: string;
  orgName: string;
  archived: boolean;
  members: OrgMemberOption[];
  workspaceCount: number;
  orgBan?: BanRecord | null;
}

export function OrgDangerZone({
  orgId,
  orgName,
  archived,
  members,
  workspaceCount,
  orgBan,
}: OrgDangerZoneProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Danger Zone</CardTitle>
        <CardDescription>High-impact organization actions</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="destructive">
          <AlertDescription>
            Ban + purge is the real fraud/spam path. Archive and hard delete
            remain available for non-abuse admin workflows.
          </AlertDescription>
        </Alert>
        {orgBan ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">Active ban</span>
              <Badge variant="destructive">{orgBan.purge_status}</Badge>
            </div>
            <p className="mt-2 text-muted-foreground">{orgBan.reason}</p>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <BanOrgDialog
            orgId={orgId}
            orgName={orgName}
            memberCount={members.length}
            workspaceCount={workspaceCount}
            disabled={Boolean(orgBan)}
          />
          <TransferOwnershipDialog
            orgId={orgId}
            orgName={orgName}
            members={members}
          />
          <ArchiveOrgDialog
            orgId={orgId}
            orgName={orgName}
            disabled={archived || Boolean(orgBan)}
          />
          <DeleteOrgDialog
            orgId={orgId}
            orgName={orgName}
            memberCount={members.length}
            workspaceCount={workspaceCount}
            disabled={Boolean(orgBan)}
          />
          {archived ? (
            <span className="text-xs text-muted-foreground">
              Organization is archived.
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
