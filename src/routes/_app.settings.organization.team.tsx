import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.organization.team';
import { requireAuthContext, requireOrgAdmin, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { createInvitations, removeOrgMember, updateOrgMemberRole, transferOrgOwnership, setWorkspaceAccess, updateInvitationWorkspaceAccess, getOrgMembersWithWorkspaceAccess, getOrgInvitations, listOrgWorkspaces } from '@/lib/auth-do';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { TeamTable } from '@/components/settings/team-table';
import type { OrgRole, Organization, WorkspaceAccessLevel } from '@/types';
import {
  BILLING_PLAN_LIMITS,
  getBillableTeamInviteSeatChangeForCount,
  getMinimumSeats,
  getOrgBillingPlan,
  getOrgSeatCount,
  getOrgSeatLimit,
  isTeamSeatBillingSyncable,
  normalizeSeatCount,
} from '@/lib/billing-plans';
import {
  buildInvitationUrl,
  resolveAppBaseUrl,
  sendOrgInvitationEmail,
} from '@/lib/email.server';
import {
  getVerifiedLegacyStripeMigrationEligibility,
  isStripeBillingConfigured,
  createSubscriptionUpdatePortalSession,
} from '@/lib/billing.server';
import {
  MAX_INVITE_EMAILS,
  parseSubmittedInviteEmails,
} from '@/lib/invite-emails';

export function meta() {
  return [
    { title: 'Team - Settings - camelAI' },
    { name: 'description', content: 'Manage team members' },
  ];
}

function getInviteRequestEmails(formData: FormData) {
  const submittedEmails = formData
    .getAll('emails')
    .filter((value): value is string => typeof value === 'string');
  const legacyEmail = formData.get('email');
  if (submittedEmails.length === 0 && typeof legacyEmail === 'string') {
    submittedEmails.push(legacyEmail);
  }
  return parseSubmittedInviteEmails(submittedEmails);
}

function getInviteBillingSnapshot(
  org: Organization,
  occupiedSeatCount: number,
  requestedInviteCount: number,
  isTeamSeatManaged: boolean,
) {
  if (!isTeamSeatManaged) {
    const seatCount = getOrgSeatCount(org);
    return {
      coveredSeatCount: seatCount,
      occupiedSeatCount,
      requestedInviteCount,
      nextSeatCount: seatCount,
      addedSeatCount: 0,
      addedMonthlyAmountCents: 0,
    };
  }

  const billingChange = getBillableTeamInviteSeatChangeForCount(
    org,
    occupiedSeatCount,
    requestedInviteCount,
  );
  if (billingChange) return billingChange;

  const coveredSeatCount = getOrgSeatCount(org);
  const nextSeatCount = normalizeSeatCount(
    'team',
    occupiedSeatCount + requestedInviteCount,
  );
  const addedSeatCount = Math.max(0, nextSeatCount - coveredSeatCount);
  return {
    coveredSeatCount,
    occupiedSeatCount,
    requestedInviteCount,
    nextSeatCount,
    addedSeatCount,
    addedMonthlyAmountCents:
      addedSeatCount * (BILLING_PLAN_LIMITS.team.monthlyPriceCents ?? 0),
  };
}

function isSeatCapacityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith('Your current billing plan includes ')
  );
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const formData = await request.formData();
  const intent = formData.get('intent');
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgId = authContext.currentOrg!.id;
  const actorId = authContext.user!.id;

  // Members can only leave (remove themselves) — all other actions require admin
  if (intent === 'removeOrgMember') {
    const userId = formData.get('userId') as string;
    if (!userId) {
      return { error: 'User ID is required' };
    }
    // Non-admins can only remove themselves (leave org)
    if (userId !== actorId) {
      await requireOrgAdmin(request, context, orgId);
    }
    await removeOrgMember(authEnv, orgId, userId, actorId);
    return { success: true };
  }

  // All remaining actions require admin/owner
  await requireOrgAdmin(request, context, orgId);

  if (intent === 'buyTeamCapacity') {
    const requestedInviteCount = Number(formData.get('requestedInviteCount'));
    if (
      !Number.isInteger(requestedInviteCount) ||
      requestedInviteCount <= 0 ||
      requestedInviteCount > MAX_INVITE_EMAILS
    ) {
      return { error: 'A valid invitation count is required' };
    }

    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    const freshOrg = await orgStub.getInfo();
    if (!freshOrg) return { error: 'Organization not found' };
    if (
      getOrgBillingPlan(freshOrg) !== 'team' ||
      freshOrg.billing_status === 'enterprise'
    ) {
      return { error: 'Team seat capacity is not managed through Stripe' };
    }

    const subscriptionStatus =
      freshOrg.billing_subscription_status ?? freshOrg.billing_status;
    if (!['active', 'trialing'].includes(subscriptionStatus)) {
      return {
        error: 'billing_update_paused',
        message:
          'Your subscription needs attention before you can buy more seats.',
      };
    }

    const [members, invitations] = await Promise.all([
      getOrgMembersWithWorkspaceAccess(authEnv, orgId),
      getOrgInvitations(authEnv, orgId),
    ]);
    const coveredSeatCount = getOrgSeatCount(freshOrg);
    const occupiedSeatCount = members.length + invitations.length;
    const targetSeatCount = normalizeSeatCount(
      'team',
      occupiedSeatCount + requestedInviteCount,
    );
    if (targetSeatCount <= coveredSeatCount) {
      return { success: true, alreadyCovered: true };
    }
    if (targetSeatCount < occupiedSeatCount) {
      return { error: 'Seat count cannot be lower than current usage' };
    }

    try {
      const returnUrl = new URL('/settings/organization/team', request.url).toString();
      const billingPortalUrl = await createSubscriptionUpdatePortalSession({
        env,
        org: freshOrg,
        plan: 'team',
        seatCount: targetSeatCount,
        returnUrl,
      });
      if (!billingPortalUrl) {
        return { success: true, alreadyCovered: true };
      }
      return { billingPortalUrl };
    } catch (error) {
      console.error('Failed to create Team capacity purchase flow', {
        orgId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        error: 'billing_update_failed',
        message: 'Could not open Stripe. Please try again.',
      };
    }
  }

  if (intent === 'createInvitation') {
    const parsedEmails = getInviteRequestEmails(formData);
    const role = (formData.get('role') || 'member') as OrgRole;
    if (role === 'owner') {
      return { error: 'Cannot invite as owner' };
    }
    if (!['admin', 'member', 'viewer'].includes(role)) {
      return { error: 'Valid role is required' };
    }
    if (parsedEmails.rejectedTokens.length > 0) {
      return { error: 'Valid email is required' };
    }
    if (parsedEmails.emails.length === 0) {
      return { error: 'At least one email is required' };
    }
    if (parsedEmails.emails.length > MAX_INVITE_EMAILS) {
      return { error: `Invite up to ${MAX_INVITE_EMAILS} people at a time` };
    }

    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    const freshOrg = await orgStub.getInfo();
    if (!freshOrg) {
      return { error: 'Organization not found' };
    }

    const [freshMembers, activeInvitations] = await Promise.all([
      getOrgMembersWithWorkspaceAccess(authEnv, orgId),
      getOrgInvitations(authEnv, orgId),
    ]);
    const memberEmails = new Set(
      freshMembers.map((member) => member.user.email.toLowerCase()),
    );
    const invitedEmails = new Set(
      activeInvitations.map((invitation) => invitation.email.toLowerCase()),
    );

    const skipped: Array<{
      email: string;
      reason: 'already_member' | 'already_invited' | 'duplicate';
    }> = parsedEmails.duplicateEmails.map((email) => ({
      email,
      reason: 'duplicate',
    }));
    const newEmails: string[] = [];
    for (const email of parsedEmails.emails) {
      if (memberEmails.has(email)) {
        skipped.push({ email, reason: 'already_member' });
      } else if (invitedEmails.has(email)) {
        skipped.push({ email, reason: 'already_invited' });
      } else {
        newEmails.push(email);
      }
    }

    if (newEmails.length === 0) {
      return {
        success: true,
        invited: [],
        skipped,
        failed: [],
      };
    }

    const occupiedSeatCount = freshMembers.length + activeInvitations.length;
    const isTeamSeatManaged =
      getOrgBillingPlan(freshOrg) === 'team' &&
      freshOrg.billing_status !== 'enterprise';
    const billingSnapshot = getInviteBillingSnapshot(
      freshOrg,
      occupiedSeatCount,
      newEmails.length,
      isTeamSeatManaged,
    );
    if (billingSnapshot.addedSeatCount > 0) {
      return {
        success: false,
        error: 'insufficient_paid_seats',
        billing: billingSnapshot,
        message:
          'Buy the additional Team capacity in Stripe before sending these invitations.',
      };
    }

    let invitations: Awaited<ReturnType<typeof createInvitations>>;
    try {
      invitations = await createInvitations(
        authEnv,
        orgId,
        newEmails,
        role,
        actorId,
      );
    } catch (error) {
      if (isSeatCapacityError(error)) {
        const [latestOrg, latestMembers, latestInvitations] = await Promise.all([
          orgStub.getInfo(),
          getOrgMembersWithWorkspaceAccess(authEnv, orgId),
          getOrgInvitations(authEnv, orgId),
        ]);
        return {
          success: false,
          error: 'insufficient_paid_seats',
          billing: latestOrg
            ? getInviteBillingSnapshot(
                latestOrg,
                latestMembers.length + latestInvitations.length,
                newEmails.length,
                getOrgBillingPlan(latestOrg) === 'team' &&
                  latestOrg.billing_status !== 'enterprise',
              )
            : billingSnapshot,
          message:
            'Available paid seat capacity changed. Buy more seats before retrying.',
        };
      }
      return {
        success: false,
        error:
          error instanceof Error ? error.message : 'Failed to create invitations',
      };
    }
    const baseUrl = resolveAppBaseUrl(env, new URL(request.url));
    const deliveries = await Promise.allSettled(
      invitations.map(async (invitation) => {
        const invitationUrl = buildInvitationUrl(baseUrl, orgId, invitation.id);
        const emailDelivery = await sendOrgInvitationEmail({
          env,
          to: invitation.email,
          orgName: freshOrg.name,
          inviterName: authContext.user.name ?? authContext.user.email,
          role,
          invitationUrl,
          expiresAt: invitation.expires_at,
        });
        return { invitation, emailDelivery };
      }),
    );

    const failed = deliveries.flatMap((delivery, index) => {
      const invitation = invitations[index];
      if (delivery.status === 'rejected') {
        return [{ email: invitation.email, reason: 'email_delivery_failed' }];
      }
      if (delivery.value.emailDelivery.status === 'sent') return [];
      return [
        {
          email: invitation.email,
          reason: delivery.value.emailDelivery.reason ?? delivery.value.emailDelivery.status,
        },
      ];
    });

    return {
      success: true,
      invited: invitations.map((invitation) => ({
        email: invitation.email,
        invitation_id: invitation.id,
      })),
      skipped,
      failed,
      billing: billingSnapshot,
    };
  }

  if (intent === 'updateOrgMemberRole') {
    const userId = formData.get('userId') as string;
    const role = formData.get('role') as OrgRole;
    if (!userId || !role) {
      return { error: 'User ID and role are required' };
    }
    await updateOrgMemberRole(authEnv, orgId, userId, role, actorId);
    return { success: true };
  }

  if (intent === 'transferOrgOwnership') {
    const newOwnerId = formData.get('newOwnerId') as string;
    if (!newOwnerId) {
      return { error: 'New owner ID is required' };
    }
    // Only the current owner can transfer ownership (not just any admin)
    const currentUserOrg = authContext.orgs.find((o) => o.org_id === orgId);
    if (currentUserOrg?.role !== 'owner') {
      return { error: 'Only the organization owner can transfer ownership' };
    }
    await transferOrgOwnership(authEnv, orgId, newOwnerId, actorId);
    return { success: true };
  }

  if (intent === 'deleteInvitation') {
    const invitationId = formData.get('invitationId') as string;
    if (!invitationId) {
      return { error: 'Invitation ID is required' };
    }
    const stub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    await stub.deleteInvitation(invitationId);
    return { success: true };
  }

  if (intent === 'updateWorkspaceAccess') {
    const userId = formData.get('userId') as string;
    const workspaceId = formData.get('workspaceId') as string;
    const access = formData.get('access') as WorkspaceAccessLevel;
    if (!userId || !workspaceId || !access) {
      return { error: 'User ID, workspace ID, and access level are required' };
    }
    await setWorkspaceAccess(authEnv, workspaceId, userId, access, actorId);
    return { success: true };
  }

  if (intent === 'updateInvitationWorkspaceAccess') {
    const invitationId = formData.get('invitationId') as string;
    const workspaceId = formData.get('workspaceId') as string;
    const access = formData.get('access') as WorkspaceAccessLevel;
    if (!invitationId || !workspaceId || !access) {
      return { error: 'Invitation ID, workspace ID, and access level are required' };
    }
    await updateInvitationWorkspaceAccess(authEnv, orgId, invitationId, workspaceId, access);
    return { success: true };
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const [members, invitations, workspaces] = await Promise.all([
    getOrgMembersWithWorkspaceAccess(authEnv, authContext.currentOrg.id),
    getOrgInvitations(authEnv, authContext.currentOrg.id),
    listOrgWorkspaces(authEnv, authContext.currentOrg.id),
  ]);

  // Determine current user's role in this org
  const currentMember = members.find((m) => m.user.id === authContext.user.id);
  const currentUserRole = currentMember?.role ?? 'member';
  const canManageMembers = currentUserRole === 'owner' || currentUserRole === 'admin';

  const seatLimit = getOrgSeatLimit(authContext.currentOrg);
  const requiresTeamUpgrade =
    canManageMembers && seatLimit !== null && seatLimit <= 1;

  const stripeConfigured = isStripeBillingConfigured(env);
  const legacyMigration = requiresTeamUpgrade
    ? await getVerifiedLegacyStripeMigrationEligibility({
        env,
        org: authContext.currentOrg,
        userEmail: authContext.user.email,
      })
    : null;
  const currentPlan = getOrgBillingPlan(authContext.currentOrg);

  return {
    org: authContext.currentOrg,
    members,
    invitations,
    teamInviteBillingContext:
      getOrgBillingPlan(authContext.currentOrg) === 'team' &&
      authContext.currentOrg.billing_status !== 'enterprise'
        ? {
            occupiedSeatCount: members.length + invitations.length,
            coveredSeatCount: getOrgSeatCount(authContext.currentOrg),
            unitMonthlyAmountCents:
              BILLING_PLAN_LIMITS.team.monthlyPriceCents ?? 0,
            minimumSeats: getMinimumSeats('team'),
            syncable: isTeamSeatBillingSyncable(authContext.currentOrg),
          }
        : null,
    workspaces,
    currentUserId: authContext.user.id,
    canManageMembers,
    requiresTeamUpgrade,
    currentPlan,
    stripeConfigured,
    legacyMigration,
  };
}

export default function TeamPage() {
  const {
    org,
    members,
    invitations,
    teamInviteBillingContext,
    workspaces,
    currentUserId,
    canManageMembers,
    requiresTeamUpgrade,
    currentPlan,
    stripeConfigured,
    legacyMigration,
  } =
    useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Team"
        description="Invite and manage team members."
      />
      <Separator />
      <TeamTable
        orgId={org.id}
        currentUserId={currentUserId}
        canManageMembers={canManageMembers}
        members={members}
        invitations={invitations}
        workspaces={workspaces}
        requiresTeamUpgrade={requiresTeamUpgrade}
        currentPlan={currentPlan}
        stripeConfigured={stripeConfigured}
        legacyMigration={legacyMigration}
        teamInviteBillingContext={teamInviteBillingContext}
      />
    </div>
  );
}
