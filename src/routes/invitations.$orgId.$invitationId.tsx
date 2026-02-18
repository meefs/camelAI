'use client';

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useNavigate, useRouteLoaderData } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { LogoIcon } from '@/components/ui/logo';
import { Skeleton } from '@/components/ui/skeleton';
import type { OrgRole, User } from '@/types';
import { Loader2 } from 'lucide-react';

export function meta() {
  return [
    { title: 'Accept Invitation - camelAI' },
    { name: 'description', content: 'Accept your organization invitation' },
  ];
}

interface InvitationData {
  email: string;
  role: OrgRole;
  org: {
    id: string;
    name: string;
  };
}

type PageStatus = 'loading' | 'ready' | 'error' | 'accepting' | 'success';

const errorTitle = 'Invitation not found';
const errorDescription =
  'This invitation may have expired, the link may be incorrect, or it was sent to a different email address.';
const errorHelper =
  'Please contact the organization administrator for a new invitation.';

function buildLoginHref(orgId?: string, invitationId?: string) {
  if (!orgId || !invitationId) {
    return '/login';
  }
  return `/login?redirect=${encodeURIComponent(`/invitations/${orgId}/${invitationId}`)}`;
}

export default function InvitationPage() {
  const params = useParams();
  const navigate = useNavigate();
  const inviteData = useRouteLoaderData('routes/_invite') as { user: User | null } | undefined;
  const user = inviteData?.user ?? null;
  const orgId = params.orgId;
  const invitationId = params.invitationId;

  const loginHref = useMemo(
    () => buildLoginHref(orgId, invitationId),
    [orgId, invitationId]
  );

  const [status, setStatus] = useState<PageStatus>('loading');
  const [invitation, setInvitation] = useState<InvitationData | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineSubmitting, setDeclineSubmitting] = useState(false);

  const isAccepting = status === 'accepting';
  const isBusy = isAccepting || declineSubmitting;
  const showInviteCard = status === 'ready' || status === 'accepting';

  useEffect(() => {
    if (!orgId || !invitationId) {
      setStatus('error');
      return;
    }

    let active = true;
    setStatus('loading');

    const loadInvitation = async () => {
      try {
        const response = await fetch(
          `/api/invitations/${orgId}/${invitationId}`
        );
        if (!response.ok) {
          if (active) {
            setInvitation(null);
            setStatus('error');
          }
          return;
        }
        const data = (await response.json()) as InvitationData;
        if (!active) return;
        if (!data?.org?.name || !data?.role) {
          setInvitation(null);
          setStatus('error');
          return;
        }
        setInvitation(data);
        setStatus('ready');
      } catch {
        if (active) {
          setInvitation(null);
          setStatus('error');
        }
      }
    };

    loadInvitation();

    return () => {
      active = false;
    };
  }, [orgId, invitationId]);

  useEffect(() => {
    if (status !== 'ready' || !invitation || !user) return;
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      setStatus('error');
    }
  }, [status, invitation, user]);

  useEffect(() => {
    if (status !== 'success') return;
    const timeout = setTimeout(() => {
      // Hard redirect to force full page reload and auth context refresh
      window.location.href = '/onboarding?team=1';
    }, 1000);
    return () => clearTimeout(timeout);
  }, [status]);

  const handleAccept = async () => {
    if (!orgId || !invitationId) return;
    if (!user) {
      navigate(loginHref);
      return;
    }

    setStatus('accepting');

    try {
      const response = await fetch(
        `/api/invitations/${orgId}/${invitationId}`,
        {
          method: 'POST',
        }
      );
      if (response.status === 401) {
        navigate(loginHref);
        return;
      }
      if (!response.ok) {
        setStatus('error');
        return;
      }
      setStatus('success');
    } catch {
      setStatus('error');
    }
  };

  const handleDecline = async () => {
    if (!orgId || !invitationId) return;
    if (!user) {
      navigate(loginHref);
      return;
    }

    setDeclineSubmitting(true);

    try {
      const response = await fetch(`/api/orgs/${orgId}/invite`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitation_id: invitationId }),
      });
      if (response.status === 401) {
        navigate(loginHref);
        return;
      }
      if (!response.ok) {
        setStatus('error');
        return;
      }
      navigate('/');
    } catch {
      setStatus('error');
    } finally {
      setDeclineSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link to="/" className="flex items-center justify-center gap-2">
          <LogoIcon />
          <span className="text-lg font-semibold tracking-tight">
            camelAI
          </span>
        </Link>

        <Card className="w-full">
          {status === 'loading' && (
            <>
              <CardHeader className="text-center">
                <Skeleton className="mx-auto h-6 w-48" />
                <Skeleton className="mx-auto h-4 w-32" />
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </CardContent>
            </>
          )}

          {status === 'error' && (
            <>
              <CardHeader className="text-center">
                <CardTitle className="text-lg">{errorTitle}</CardTitle>
                <CardDescription className="text-balance">
                  {errorDescription}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-center text-sm text-muted-foreground">
                  {errorHelper}
                </p>
                <Button asChild className="w-full" size="lg">
                  <Link to="/">Go home</Link>
                </Button>
              </CardContent>
            </>
          )}

          {status === 'success' && invitation && (
            <>
              <CardHeader className="text-center">
                <CardTitle className="text-lg">Invitation accepted</CardTitle>
                <CardDescription>
                  Redirecting to {invitation.org.name}...
                </CardDescription>
              </CardHeader>
              <CardContent className="flex justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </CardContent>
            </>
          )}

          {showInviteCard && invitation && (
            <>
              <CardHeader className="text-center">
                <CardTitle className="text-lg">
                  You&apos;re invited to join
                </CardTitle>
                <CardDescription className="text-base font-semibold text-foreground">
                  {invitation.org.name}
                </CardDescription>
                <div className="text-sm text-muted-foreground">
                  You&apos;ll still have access to any other orgs or workspaces
                  you&apos;re part of. This just adds you to a new one.
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {user ? (
                  <>
                    <Button
                      onClick={handleAccept}
                      disabled={isBusy}
                      className="w-full"
                      size="lg"
                      aria-busy={isAccepting}
                    >
                      {isAccepting ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Accepting...
                        </>
                      ) : (
                        'Accept invitation'
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setDeclineOpen(true)}
                      disabled={isBusy}
                      className="w-full"
                      size="lg"
                    >
                      Decline
                    </Button>
                  </>
                ) : (
                  <Button asChild className="w-full" size="lg">
                    <Link to={loginHref}>Sign in to accept</Link>
                  </Button>
                )}
              </CardContent>
            </>
          )}
        </Card>

        {showInviteCard && invitation ? (
          <ConfirmDialog
            open={declineOpen}
            onOpenChange={setDeclineOpen}
            title="Decline invitation?"
            description={`This will remove the invitation to join ${invitation.org.name}. You'll need a new link to join later.`}
            confirmLabel={declineSubmitting ? 'Declining...' : 'Decline invitation'}
            variant="destructive"
            onConfirm={handleDecline}
          />
        ) : null}
      </div>
    </div>
  );
}
