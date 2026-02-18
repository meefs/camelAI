import { Link, useLoaderData } from 'react-router';
import type { Route } from './+types/_admin.invitations';
import { requireSuperuser, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as authDO from '@/lib/auth-do.server';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { AdminPagination } from '@/components/admin/admin-pagination';
import { AdminSearch } from '@/components/admin/admin-search';
import { InvitationActions } from '@/components/admin/invitation-actions';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const LIMIT = 50;

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(value: number) {
  return dateFormatter.format(new Date(value));
}

function formatDuration(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function formatExpiry(expiresAt: number, now: number) {
  const diff = expiresAt - now;
  if (diff >= 0) {
    return `${formatDuration(diff)} remaining`;
  }
  return `Expired ${formatDuration(Math.abs(diff))} ago`;
}

export function meta() {
  return [
    { title: 'Invitations - Admin - camelAI' },
    { name: 'description', content: 'Manage invitations' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  await requireSuperuser(request, context);

  const formData = await request.formData();
  const intent = formData.get('intent');
  const authEnv = getAuthEnv(getEnv(context));

  if (intent === 'deleteInvitation') {
    const invitationId = formData.get('invitationId') as string;
    const orgId = formData.get('orgId') as string;
    if (!invitationId || !orgId) {
      return { error: 'Invitation ID and Org ID are required' };
    }
    const stub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    await stub.deleteInvitation(invitationId);
    return { success: true };
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const url = new URL(request.url);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const search = url.searchParams.get('search')?.trim() || '';

  const { items: invitations, total } = await authDO.adminGetInvitationsPaginated(context, {
    offset,
    limit: LIMIT,
    search: search || undefined,
  });

  const baseUrl = search
    ? `/qaml-backdoor/invitations?search=${encodeURIComponent(search)}`
    : '/qaml-backdoor/invitations';

  const now = Date.now();

  return { invitations, total, offset, search, baseUrl, now };
}

export default function AdminInvitationsPage() {
  const { invitations, total, offset, baseUrl, now } = useLoaderData<typeof loader>();

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Invitations' },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-6xl mx-auto w-full px-4 md:px-6 py-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-4">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Invitations</h1>
              <p className="text-sm text-muted-foreground">
                {total} total invitations
              </p>
              <p className="text-xs text-muted-foreground">
                Accepted invitations are recorded in organization audit logs.
              </p>
            </div>
            <div className="w-full sm:w-64">
              <AdminSearch placeholder="Search invitations" />
            </div>
          </div>

          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Invited By</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      No invitations found
                    </TableCell>
                  </TableRow>
                ) : (
                  invitations.map((invitation) => {
                    const isExpired = invitation.expires_at <= now;
                    const inviterLabel = invitation.inviter_name
                      ? invitation.inviter_name
                      : invitation.inviter_email;
                    const inviterSecondary = invitation.inviter_name
                      ? invitation.inviter_email
                      : null;

                    return (
                      <TableRow key={`${invitation.org_id}-${invitation.id}`}>
                        <TableCell>
                          <div className="font-medium text-foreground">{invitation.email}</div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {invitation.id.slice(0, 8)}...
                          </div>
                        </TableCell>
                        <TableCell>
                          <Link
                            to={`/qaml-backdoor/orgs/${invitation.org_id}`}
                            className="block hover:underline"
                          >
                            <div className="font-medium text-foreground">{invitation.org_name}</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {invitation.org_id.slice(0, 8)}...
                            </div>
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{invitation.role}</Badge>
                        </TableCell>
                        <TableCell>
                          <Link
                            to={`/qaml-backdoor/users/${invitation.invited_by}`}
                            className="block hover:underline"
                          >
                            <div className="font-medium text-foreground">{inviterLabel}</div>
                            {inviterSecondary ? (
                              <div className="text-xs text-muted-foreground">{inviterSecondary}</div>
                            ) : null}
                            <div className="text-xs text-muted-foreground font-mono">
                              {invitation.invited_by.slice(0, 8)}...
                            </div>
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant={isExpired ? 'secondary' : 'default'}>
                            {isExpired ? 'Expired' : 'Pending'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatTimestamp(invitation.created_at)}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">{formatExpiry(invitation.expires_at, now)}</div>
                          <div className="text-xs text-muted-foreground">
                            {formatTimestamp(invitation.expires_at)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <InvitationActions
                            orgId={invitation.org_id}
                            invitationId={invitation.id}
                            inviteeEmail={invitation.email}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <AdminPagination
            total={total}
            offset={offset}
            limit={LIMIT}
            baseUrl={baseUrl}
          />
        </div>
      </div>
    </>
  );
}
