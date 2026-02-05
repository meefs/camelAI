"use client"

import { useEffect, useRef, useState } from "react"
import { useFetcher } from "react-router"
import { toast } from "sonner"
import { MoreHorizontal, Plus } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useAuthData } from "@/hooks/use-auth-data"
import { useSwitchOrg } from "@/hooks/use-auth-actions"
import { CreateOrgDialog } from "@/components/settings/create-org-dialog"
import type { BillingStatus, OrgRole } from "@/types"

interface OrgMembershipSummary {
  org_id: string
  org_name: string
  role: OrgRole
  joined_at: number
  billing_status: BillingStatus
  member_count: number
  workspace_count: number
}

interface OrgMembershipsListProps {
  orgs: OrgMembershipSummary[]
  currentUserId: string
}

function formatDate(value: number) {
  return new Date(value).toLocaleDateString()
}

export function OrgMembershipsList({
  orgs,
  currentUserId,
}: OrgMembershipsListProps) {
  const { currentOrg } = useAuthData()
  const { switchOrg } = useSwitchOrg()
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const [createOpen, setCreateOpen] = useState(false)
  const [leaveTargetId, setLeaveTargetId] = useState<string | null>(null)
  const pendingLeaveRef = useRef<string | null>(null)

  // Handle fetcher response for leave
  // React Router auto-revalidates loaders after fetcher actions complete
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success && pendingLeaveRef.current) {
        pendingLeaveRef.current = null
        setLeaveTargetId(null)
        toast.success("Left organization")
      } else if (fetcher.data.error) {
        pendingLeaveRef.current = null
        toast.error(fetcher.data.error)
      }
    }
  }, [fetcher.state, fetcher.data])

  const handleSwitchOrg = (orgId: string) => {
    switchOrg(orgId)
    toast.success("Switched organization")
  }

  const handleLeaveOrg = (orgId: string) => {
    pendingLeaveRef.current = orgId
    fetcher.submit(
      { intent: "leaveOrg", orgId },
      { method: "POST" }
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 size-4" />
          Create organization
        </Button>
      </div>

      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Organization</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Stats</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orgs.map((org) => (
              <TableRow
                key={org.org_id}
                className={org.org_id === currentOrg?.id ? "bg-muted/50" : ""}
              >
                <TableCell className="font-medium">{org.org_name}</TableCell>
                <TableCell>
                  <Badge variant={org.role === "owner" ? "default" : "outline"}>
                    {org.role}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      org.billing_status === "paying" ? "default" : "secondary"
                    }
                  >
                    {org.billing_status === "paying" ? "Pro" : "Free"}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {org.member_count} members / {org.workspace_count} workspaces
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDate(org.joined_at)}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[180px]">
                      <DropdownMenuItem
                        onClick={() => handleSwitchOrg(org.org_id)}
                        className="whitespace-nowrap"
                      >
                        Switch to this org
                      </DropdownMenuItem>
                      {org.role !== "owner" ? (
                        <DropdownMenuItem
                          onClick={() => setLeaveTargetId(org.org_id)}
                          className="whitespace-nowrap text-destructive"
                        >
                          Leave organization
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-3 md:hidden">
        {orgs.map((org) => (
          <Card key={org.org_id}>
            <CardHeader className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-sm">{org.org_name}</CardTitle>
                <Badge variant={org.role === "owner" ? "default" : "outline"}>
                  {org.role}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge
                  variant={
                    org.billing_status === "paying" ? "default" : "secondary"
                  }
                >
                  {org.billing_status === "paying" ? "Pro" : "Free"}
                </Badge>
                <span>
                  {org.member_count} members / {org.workspace_count} workspaces
                </span>
              </div>
            </CardHeader>
            <CardContent className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Joined {formatDate(org.joined_at)}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon">
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[180px]">
                  <DropdownMenuItem
                    onClick={() => handleSwitchOrg(org.org_id)}
                    className="whitespace-nowrap"
                  >
                    Switch to this org
                  </DropdownMenuItem>
                  {org.role !== "owner" ? (
                    <DropdownMenuItem
                      onClick={() => setLeaveTargetId(org.org_id)}
                      className="whitespace-nowrap text-destructive"
                    >
                      Leave organization
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </CardContent>
          </Card>
        ))}
      </div>
      <CreateOrgDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog
        open={Boolean(leaveTargetId)}
        onOpenChange={(open) => {
          if (!open) setLeaveTargetId(null)
        }}
        title="Leave organization?"
        description="You will lose access to this organization and its workspaces."
        confirmLabel="Leave organization"
        variant="destructive"
        onConfirm={() => {
          if (leaveTargetId) {
            void handleLeaveOrg(leaveTargetId)
          }
        }}
      />
    </div>
  )
}
