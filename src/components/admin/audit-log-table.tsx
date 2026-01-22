import { Link } from 'react-router';

import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { AuditLogEntry, User } from "@/types"

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
})

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value))
}

type AuditLogUser = Pick<User, "id" | "email" | "name">

interface AuditLogTableProps {
  entries: AuditLogEntry[]
  users?: AuditLogUser[]
}

export function AuditLogTable({ entries, users = [] }: AuditLogTableProps) {
  const userById = new Map(users.map((user) => [user.id, user]))

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Action</TableHead>
          <TableHead>Actor</TableHead>
          <TableHead>Target</TableHead>
          <TableHead>Details</TableHead>
          <TableHead>Timestamp</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
              No audit log entries found
            </TableCell>
          </TableRow>
        ) : (
          entries.map((entry) => {
            const actor = userById.get(entry.actor_id)
            const target = entry.target_id ? userById.get(entry.target_id) : null
            return (
              <TableRow key={entry.id}>
                <TableCell>
                  <Badge variant="outline">{entry.action}</Badge>
                </TableCell>
                <TableCell>
                  <Link
                    to={`/qaml-backdoor/users/${entry.actor_id}`}
                    className="hover:underline"
                  >
                    <div className="text-sm font-medium">
                      {actor?.name || actor?.email || entry.actor_id}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {entry.actor_id.slice(0, 8)}...
                    </div>
                  </Link>
                </TableCell>
                <TableCell>
                  {entry.target_id ? (
                    target ? (
                      <Link
                        to={`/qaml-backdoor/users/${entry.target_id}`}
                        className="hover:underline"
                      >
                        <div className="text-sm font-medium">
                          {target.name || target.email || entry.target_id}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {entry.target_id.slice(0, 8)}...
                        </div>
                      </Link>
                    ) : (
                      <span className="text-xs font-mono text-muted-foreground">
                        {entry.target_id.slice(0, 8)}...
                      </span>
                    )
                  ) : (
                    <span className="text-xs text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell>
                  {entry.details ? (
                    <pre className="text-xs text-muted-foreground whitespace-pre-wrap max-w-[320px]">
                      {JSON.stringify(entry.details, null, 2)}
                    </pre>
                  ) : (
                    <span className="text-xs text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatTimestamp(entry.created_at)}
                </TableCell>
              </TableRow>
            )
          })
        )}
      </TableBody>
    </Table>
  )
}
