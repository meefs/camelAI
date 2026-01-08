"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  MoreHorizontal,
  Plus,
} from "lucide-react"
import { useRouter } from "next/navigation"

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
import { useAuth } from "@/contexts/AuthContext"
import {
  deleteInvitation,
  removeOrgMember,
  updateOrgMemberRole,
} from "@/lib/server-actions/org"
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
  orgId: string
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
  orgId,
  currentUserId,
  canManageMembers,
  members,
  invitations,
  workspaces,
}: TeamTableProps) {
  const router = useRouter()
  const { logout } = useAuth()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [editingWorkspaceAccess, setEditingWorkspaceAccess] = useState(false)
  const [memberList, setMemberList] = useState<MemberWithAccess[]>(members)
  const [inviteList, setInviteList] = useState<TeamInvitation[]>(invitations)

  useEffect(() => {
    setMemberList(members)
  }, [members])

  useEffect(() => {
    setInviteList(invitations)
  }, [invitations])

  const rows = useMemo<TeamTableRow[]>(() => {
    const memberRows = memberList.map((member) => ({
      type: "member" as const,
      member,
    }))
    const invitationRows = inviteList.map((invitation) => ({
      type: "invitation" as const,
      invitation,
    }))
    return [...memberRows, ...invitationRows]
  }, [inviteList, memberList])

  const canEditWorkspaceAccess = canManageMembers && workspaces.length > 0

  const isOwner = useMemo(() => {
    const self = memberList.find((member) => member.user.id === currentUserId)
    return self?.role === "owner"
  }, [currentUserId, memberList])

  const handleCancelInvite = async (invitationId: string) => {
    try {
      await deleteInvitation(orgId, invitationId)
      setInviteList((prev) => prev.filter((inv) => inv.id !== invitationId))
      toast.success("Invitation cancelled")
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to cancel invitation"
      )
    }
  }

  const handleRoleChange = async (userId: string, role: OrgRole) => {
    try {
      await updateOrgMemberRole(orgId, userId, role)
      setMemberList((prev) =>
        prev.map((member) =>
          member.user.id === userId ? { ...member, role } : member
        )
      )
      toast.success("Role updated")
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update role"
      )
    }
  }

  const handleRemoveMember = async (userId: string) => {
    if (!confirm("Remove this member from the organization?")) return
    try {
      await removeOrgMember(orgId, userId)
      setMemberList((prev) => prev.filter((member) => member.user.id !== userId))
      toast.success("Member removed")
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove member"
      )
    }
  }

  const handleLeaveOrg = async () => {
    if (!confirm("Leave this organization?")) return
    try {
      await removeOrgMember(orgId, currentUserId)
      await logout()
      router.push("/login")
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to leave organization"
      )
    }
  }

  const updateWorkspaceAccess = (
    userId: string,
    workspaceId: string,
    access: WorkspaceAccessLevel
  ) => {
    setMemberList((prev) =>
      prev.map((member) => {
        if (member.user.id !== userId) return member
        return {
          ...member,
          workspaceAccess: {
            ...member.workspaceAccess,
            [workspaceId]: access,
          },
        }
      })
    )
  }

  const renderRoleBadge = (role: OrgRole) => (
    <Badge variant={role === "owner" ? "default" : "outline"}>{role}</Badge>
  )

  return (
    <div className="space-y-6">
      {canManageMembers ? (
        <div className="flex justify-end">
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
              <TableHead>
                <div className="flex items-center justify-between gap-2">
                  <span>Workspace access</span>
                  {canEditWorkspaceAccess ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() =>
                        setEditingWorkspaceAccess((prev) => !prev)
                      }
                    >
                      {editingWorkspaceAccess ? "Done" : "Edit"}
                    </Button>
                  ) : null}
                </div>
              </TableHead>
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
                        <Avatar className="h-8 w-8">
                          <AvatarFallback
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
                          updateWorkspaceAccess(
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
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => handleRemoveMember(member.user.id)}
                            >
                              Remove from organization
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                      {isSelf && !isOwner ? (
                        <Button variant="ghost" size="sm" onClick={handleLeaveOrg}>
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
                      <Avatar className="h-8 w-8">
                        <AvatarFallback>{inviteInitial}</AvatarFallback>
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
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => handleCancelInvite(invitation.id)}
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

      {canEditWorkspaceAccess ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground md:hidden">
          <span>Workspace access</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => setEditingWorkspaceAccess((prev) => !prev)}
          >
            {editingWorkspaceAccess ? "Done" : "Edit"}
          </Button>
        </div>
      ) : null}

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
                    <Avatar className="h-9 w-9">
                      <AvatarFallback
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
                        updateWorkspaceAccess(
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
                      onClick={() => handleRemoveMember(member.user.id)}
                    >
                      Remove from organization
                    </Button>
                  ) : null}
                  {isSelf && !isOwner ? (
                    <Button variant="ghost" onClick={handleLeaveOrg}>
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
                  <Avatar className="h-9 w-9">
                    <AvatarFallback>{inviteInitial}</AvatarFallback>
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
        orgId={orgId}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={(invitation) => {
          setInviteList((prev) => [
            {
              id: invitation.id,
              email: invitation.email,
              role: invitation.role,
              created_at: Date.now(),
              expires_at: invitation.expires_at,
            },
            ...prev,
          ])
        }}
      />
    </div>
  )
}
