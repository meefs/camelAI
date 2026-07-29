const INVITE_REASON_LABELS: Record<string, string> = {
  already_member: "already a member",
  already_invited: "invitation already sent",
  duplicate: "listed twice",
  email_delivery_failed: "couldn't deliver email",
  failed: "couldn't deliver email",
  skipped: "email delivery is not configured",
  "Cloudflare Email Sending binding EMAIL is not configured": "email delivery is not configured",
  "EMAIL_FROM_ADDRESS is not configured": "email delivery is not configured",
  "Outbound email is disabled in self-host mode. No SMTP transport is implemented.":
    "email delivery is disabled in self-host mode",
};

export function inviteReasonCopy(reason: string | null | undefined): string {
  if (!reason) return "couldn't deliver email";
  return INVITE_REASON_LABELS[reason] ?? "couldn't deliver email";
}

export function formatInviteIssue(email: string, reason: string): string {
  return `${email}: ${inviteReasonCopy(reason)}`;
}
