import { Separator } from "@/components/ui/separator"
import { SettingsHeader } from "@/components/settings/settings-header"
import { OrgMembershipsList } from "@/components/settings/org-memberships-list"
import { requireAuthContextLite } from "@/lib/server-guards"
import * as authDO from "@/lib/auth-do"

export default async function UserOrgsPage() {
  const { user } = await requireAuthContextLite()
  const orgs = await authDO.getUserOrgs(user.id)

  const orgsWithDetails = await Promise.all(
    orgs.map(async (membership) => {
      const [org, members, workspaces] = await Promise.all([
        authDO.getOrg(membership.org_id),
        authDO.getOrgMembers(membership.org_id),
        authDO.listOrgWorkspaces(membership.org_id),
      ])

      return {
        org_id: membership.org_id,
        org_name: membership.org_name,
        role: membership.role,
        joined_at: membership.joined_at,
        billing_status: org?.billing_status ?? "free",
        member_count: members.length,
        workspace_count: workspaces.length,
      }
    })
  )

  const safeOrgs = orgsWithDetails.map((org) => ({
    org_id: org.org_id,
    org_name: org.org_name,
    role: org.role,
    joined_at: org.joined_at,
    billing_status: org.billing_status,
    member_count: org.member_count,
    workspace_count: org.workspace_count,
  }))

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Organizations"
        description="Organizations you're a member of."
      />
      <Separator />
      <OrgMembershipsList orgs={safeOrgs} currentUserId={user.id} />
    </div>
  )
}
