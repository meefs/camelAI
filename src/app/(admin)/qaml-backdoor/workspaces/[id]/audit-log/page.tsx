import { notFound } from "next/navigation"

import * as authDO from "@/lib/auth-do"
import { AdminPageHeader } from "@/components/admin/admin-page-header"
import { AuditLogTable } from "@/components/admin/audit-log-table"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface Props {
  params: Promise<{ id: string }>
}

export default async function WorkspaceAuditLogPage({ params }: Props) {
  const { id } = await params
  const workspace = await authDO.getWorkspace(id)
  if (!workspace) {
    notFound()
  }

  const entries = await authDO.getWorkspaceAuditLog(id, 100, 0)
  const userIds = new Set<string>()
  for (const entry of entries) {
    userIds.add(entry.actor_id)
    if (entry.target_id) {
      userIds.add(entry.target_id)
    }
  }
  const users = userIds.size > 0 ? await authDO.getUsersByIds(Array.from(userIds)) : []

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: "Admin", href: "/qaml-backdoor" },
          { label: "Workspaces", href: "/qaml-backdoor/workspaces" },
          { label: workspace.name, href: `/qaml-backdoor/workspaces/${workspace.id}` },
          { label: "Audit Log" },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-6xl mx-auto w-full px-4 md:px-6 py-6">
          <Card>
            <CardHeader>
              <CardTitle>Workspace Audit Log</CardTitle>
              <CardDescription>Recent activity for {workspace.name}</CardDescription>
            </CardHeader>
            <CardContent>
              <AuditLogTable entries={entries} users={users} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}
