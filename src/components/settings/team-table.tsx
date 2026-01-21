"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  MoreHorizontal,
  Plus,
} from "lucide-react"
import { useNavigate, useFetcher } from 'react-router';

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { useAuth } from "@/contexts/AuthContext"
import { InviteMemberDialog } from "@/components/settings/invite-member-dialog"
import { WorkspaceAccessTags } from "@/components/settings/workspace-access-tags"
import { getContrastTextColor } from "@/lib/avatar"
import type {
  OrgRole,
  User,
  Workspace,
  WorkspaceAccessLevel,
} from "@/types"

interface MemberWithAccess {
  user: User
  role: OrgRole
  joined_at: number
  workspaceAccess: Record<string, WorkspaceAccessLevel>
}

interface TeamInvitation {
  id: string
  email: string
  role: OrgRole
  created_at: number
  expires_at: number
}

type TeamTableRow =
  | { type: "member"; member: MemberWithAccess }
  | { type: "invitation"; invitation: TeamInvitation }

interface TeamTableProps {
  currentUserId: string
  canManageMembers: boolean
  members: MemberWithAccess[]
  invitations: TeamInvitation[]
  workspaces: Workspace[]
}

function formatDate(value: number) {
  return new Date(value).toLocaleDateString()
}

export function TeamTable({
  currentUserId,
  canManageMembers,
  members,
  invitations,
  workspaces,
}: TeamTableProps) {
  const navigate = useNavigate()
  const { logout } = useAuth()
  const fetcher = useFetcher<{ success?: boolean; error?: string }>()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [editingWorkspaceAccess, setEditingWorkspaceAccess] = useState(false)
  const [pendingRemoveMemberId, setPendingRemoveMemberId] = useState<string | null>(null)
  const [leaveOrgOpen, setLeaveOrgOpen] = useState(false)
  const lastActionRef = useRef<string | null>(null)

  // Handle fetcher response - show toasts and handle special cases
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        const action = lastActionRef.current
        if (action === "cancelInvite") {
          toast.success("Invitation cancelled")
        } else if (action === "roleChange") {
          toast.success("Role updated")
        } else if (action === "removeMember") {
          toast.success("Member removed")
        } else if (action === "leaveOrg") {
          logout().then(() => navigate("/login"))
        }
        lastActionRef.current = null
      } else if (fetcher.data.error) {
        toast.error(fetcher.data.error)
        lastActionRef.current = null
      }
    }
  }, [fetcher.state, fetcher.data, logout, navigate])

  // Use loader data directly - revalidation handles refresh
  const rows = useMemo<TeamTableRow[]>(() => {
    const memberRows = members.map((member) => ({
      type: "member" as const,
      member,
    }))
    const invitationRows = invitations.map((invitation) => ({
      type: "invitation" as const,
      invitation,
    }))
    return [...memberRows, ...invitationRows]
  }, [members, invitations])

  const canEditWorkspaceAccess = canManageMembers && workspaces.length > 0

  const isOwner = useMemo(() => {
    const self = members.find((member) => member.user.id === currentUserId)
    return self?.role === "owner"
  }, [currentUserId, members])

  const handleCancelInvite = (invitationId: string) => {
    lastActionRef.current = "cancelInvite"
    fetcher.submit(
      { intent: "deleteInvitation", invitationId },
      { method: "POST" }
    )
  }

  const handleRoleChange = (userId: string, role: OrgRole) => {
    lastActionRef.current = "roleChange"
    fetcher.submit(
      { intent: "updateOrgMemberRole", userId, role },
      { method: "POST" }
    )
  }

  const handleRemoveMember = (userId: string) => {
    lastActionRef.current = "removeMember"
    fetcher.submit(
      { intent: "removeOrgMember", userId },
      { method: "POST" }
    )
  }

  const handleLeaveOrg = () => {
    lastActionRef.current = "leaveOrg"
    fetcher.submit(
      { intent: "removeOrgMember", userId: currentUserId },
      { method: "POST" }
    )
  }

  const handleWorkspaceAccessChange = (
    userId: string,
    workspaceId: string,
    access: WorkspaceAccessLevel
  ) => {
    fetcher.submit(
      { intent: "updateWorkspaceAccess", userId, workspaceId, access },
      { method: "POST" }
    )
  }

  const renderRoleBadge = (role: OrgRole) => (
    <Badge variant={role === "owner" ? "default" : "outline"}>{role}</Badge>
  )

  return (
    <div className="space-y-6">
      {canManageMembers ? (
        <div className="flex flex-wrap justify-end gap-2">
          {canEditWorkspaceAccess ? (
            <Button
              variant={editingWorkspaceAccess ? "default" : "outline"}
              onClick={() => setEditingWorkspaceAccess((prev) => !prev)}
            >
              {editingWorkspaceAccess ? "Done editing" : "Edit access"}
            </Button>
          ) : null}
          <Button onClick={() => setInviteOpen(true)}>
            <Plus className="mr-2 size-4" />
            Invite member
          </Button>
        </div>
      ) : null}

      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Workspace access</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              if (row.type === "member") {
                const member = row.member
                const isSelf = member.user.id === currentUserId
                const canEditRole =
                  canManageMembers && member.role !== "owner" && !isSelf

                return (
                  <TableRow key={member.user.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar size="default">
                          <AvatarFallback
                            content={member.user.avatar.content}
                            style={{
                              backgroundColor: member.user.avatar.color,
                              color: getContrastTextColor(member.user.avatar.color),
                            }}
                          >
                            {member.user.avatar.content}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">
                            {member.user.name || member.user.email}
                          </p>
                          {member.user.name ? (
                            <p className="text-xs text-muted-foreground">
                              {member.user.email}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {canEditRole ? (
                        <Select
                          value={member.role}
                          onValueChange={(value) =>
                            handleRoleChange(member.user.id, value as OrgRole)
                          }
                        >
                          <SelectTrigger className="w-[140px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="member">Member</SelectItem>
                            <SelectItem value="viewer">Viewer</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        renderRoleBadge(member.role)
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Badge variant="secondary" className="w-fit">
                          Active
                        </Badge>
                        <p className="text-xs text-muted-foreground">
                          Joined {formatDate(member.joined_at)}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <WorkspaceAccessTags
                        memberId={member.user.id}
                        workspaces={workspaces}
                        accessByWorkspace={member.workspaceAccess}
                        canEdit={canManageMembers}
                        editing={editingWorkspaceAccess}
                        onAccessChange={(workspaceId, access) =>
                          handleWorkspaceAccessChange(
                            member.user.id,
                            workspaceId,
                            access
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      {canManageMembers && member.role !== "owner" && !isSelf ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-[180px]">
                            <DropdownMenuItem
                              onClick={() => setPendingRemoveMemberId(member.user.id)}
                              className="whitespace-nowrap"
                            >
                              Remove from organization
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                      {isSelf && !isOwner ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setLeaveOrgOpen(true)}
                        >
                          Leave
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )
              }

              const invitation = row.invitation
              const inviteInitial =
                invitation.email?.trim().charAt(0).toUpperCase() || "?"

              return (
                <TableRow key={`invite-${invitation.id}`}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar size="default">
                        <AvatarFallback content={inviteInitial}>{inviteInitial}</AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium">{invitation.email}</p>
                        <p className="text-xs text-muted-foreground">
                          Invitation
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{invitation.role}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <Badge variant="secondary" className="w-fit">
                        Invited
                      </Badge>
                      <p className="text-xs text-muted-foreground">
                        Sent {formatDate(invitation.created_at)}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      Not yet
                    </span>
                  </TableCell>
                  <TableCell>
                    {canManageMembers ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[180px]">
                          <DropdownMenuItem
                            onClick={() => handleCancelInvite(invitation.id)}
                            className="whitespace-nowrap"
                          >
                            Cancel invitation
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-3 md:hidden">
        {rows.map((row) => {
          if (row.type === "member") {
            const member = row.member
            const isSelf = member.user.id === currentUserId
            const canEditRole =
              canManageMembers && member.role !== "owner" && !isSelf

            return (
              <Card key={member.user.id}>
                <CardHeader className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Avatar size="lg">
                      <AvatarFallback
                        content={member.user.avatar.content}
                        style={{
                          backgroundColor: member.user.avatar.color,
                          color: getContrastTextColor(member.user.avatar.color),
                        }}
                      >
                        {member.user.avatar.content}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">
                        {member.user.name || member.user.email}
                      </p>
                      {member.user.name ? (
                        <p className="text-xs text-muted-foreground">
                          {member.user.email}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {canEditRole ? (
                      <Select
                        value={member.role}
                        onValueChange={(value) =>
                          handleRoleChange(member.user.id, value as OrgRole)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="member">Member</SelectItem>
                          <SelectItem value="viewer">Viewer</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      renderRoleBadge(member.role)
                    )}
                    <Badge variant="secondary">Active</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Joined {formatDate(member.joined_at)}
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">
                      Workspace access
                    </p>
                    <WorkspaceAccessTags
                      memberId={member.user.id}
                      workspaces={workspaces}
                      accessByWorkspace={member.workspaceAccess}
                      canEdit={canManageMembers}
                      editing={editingWorkspaceAccess}
                      onAccessChange={(workspaceId, access) =>
                        handleWorkspaceAccessChange(
                          member.user.id,
                          workspaceId,
                          access
                        )
                      }
                    />
                  </div>
                {canManageMembers && member.role !== "owner" && !isSelf ? (
                  <Button
                    variant="outline"
                    onClick={() => setPendingRemoveMemberId(member.user.id)}
                  >
                    Remove from organization
                  </Button>
                ) : null}
                {isSelf && !isOwner ? (
                  <Button variant="ghost" onClick={() => setLeaveOrgOpen(true)}>
                    Leave organization
                  </Button>
                ) : null}
                </CardContent>
              </Card>
            )
          }

          const invitation = row.invitation
          const inviteInitial =
            invitation.email?.trim().charAt(0).toUpperCase() || "?"

          return (
            <Card key={`invite-${invitation.id}`}>
              <CardHeader className="space-y-3">
                <div className="flex items-center gap-3">
                  <Avatar size="lg">
                    <AvatarFallback content={inviteInitial}>{inviteInitial}</AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium">{invitation.email}</p>
                    <p className="text-xs text-muted-foreground">Invitation</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{invitation.role}</Badge>
                  <Badge variant="secondary">Invited</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <span className="text-muted-foreground">
                  Sent {formatDate(invitation.created_at)}
                </span>
                <p className="text-xs text-muted-foreground">
                  Workspace access not yet granted.
                </p>
                {canManageMembers ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleCancelInvite(invitation.id)}
                  >
                    Cancel invitation
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
      />
      <ConfirmDialog
        open={Boolean(pendingRemoveMemberId)}
        onOpenChange={(open) => {
          if (!open) setPendingRemoveMemberId(null)
        }}
        title="Remove member from organization?"
        description="This member will lose access to this organization and its workspaces."
        confirmLabel="Remove member"
        variant="destructive"
        onConfirm={() => {
          if (pendingRemoveMemberId) {
            void handleRemoveMember(pendingRemoveMemberId)
          }
        }}
      />
      <ConfirmDialog
        open={leaveOrgOpen}
        onOpenChange={setLeaveOrgOpen}
        title="Leave organization?"
        description="You will lose access to this organization and its workspaces."
        confirmLabel="Leave organization"
        variant="destructive"
        onConfirm={() => {
          void handleLeaveOrg()
        }}
      />
    </div>
  )
}
