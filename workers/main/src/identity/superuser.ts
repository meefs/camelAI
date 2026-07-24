const SUPERUSER_EMAILS = new Set([
  "admin-one@example.com",
  "admin-two@example.com",
]);

export function isSuperuserEmail(email: string | null): boolean {
  if (!email) return false;
  return SUPERUSER_EMAILS.has(email.toLowerCase());
}
