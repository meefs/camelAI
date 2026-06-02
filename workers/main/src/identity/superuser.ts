const SUPERUSER_EMAILS = new Set(["admin@example.com", "1033072+Vercantez@users.noreply.github.com"]);

export function isSuperuserEmail(email: string | null): boolean {
  if (!email) return false;
  return SUPERUSER_EMAILS.has(email.toLowerCase());
}
