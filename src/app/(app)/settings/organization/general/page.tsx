import { Separator } from "@/components/ui/separator"
import { OrgDangerZone } from "@/components/settings/org-danger-zone"
import { SettingsHeader } from "@/components/settings/settings-header"
import { OrgGeneralForm } from "@/components/settings/org-general-form"
import { requireAuthContextLite } from "@/lib/server-guards"
import * as authDO from "@/lib/auth-do"

export default async function OrgGeneralPage() {
  const authContext = await requireAuthContextLite()
  const orgId = authContext.currentOrg.id
  const safeOrg = {
    id: authContext.currentOrg.id,
    name: authContext.currentOrg.name,
    created_at: authContext.currentOrg.created_at,
    created_by: authContext.currentOrg.created_by,
    billing_status: authContext.currentOrg.billing_status,
    archived: authContext.currentOrg.archived,
    archived_at: authContext.currentOrg.archived_at,
  }
  const [isAdmin, members] = await Promise.all([
    authDO.isOrgAdmin(authContext.user.id, orgId),
    authDO.getOrgMembers(orgId),
  ])
  const self = members.find((member) => member.user.id === authContext.user.id)
  const isOwner = self?.role === "owner"
  const safeMembers = members.map((member) => ({
    user: {
      id: member.user.id,
      email: member.user.email,
      name: member.user.name,
      created_at: member.user.created_at,
      is_superuser: member.user.is_superuser,
      avatar: {
        color: member.user.avatar.color,
        content: member.user.avatar.content,
      },
      is_orphaned: member.user.is_orphaned,
    },
    role: member.role,
  }))

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Organization"
        description="Manage your organization settings."
      />
      <Separator />
      <OrgGeneralForm org={safeOrg} canEdit={isAdmin} />

      <Separator className="my-8" />
      <div className="space-y-4">
        <OrgDangerZone
          orgId={orgId}
          orgName={authContext.currentOrg.name}
          members={safeMembers}
          isOwner={isOwner}
        />
      </div>
    </div>
  )
}
