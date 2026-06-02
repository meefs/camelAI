export const MAX_QAML_CREDIT_GRANT_CENTS = 1_000_000;

export function parseCreditGrantAmountCents(
  value: FormDataEntryValue | null,
): {
  amountCents?: number;
  error?: string;
} {
  const raw = typeof value === "string" ? value.trim().replace(/^\$/, "") : "";
  if (!raw) return { error: "Credit amount is required" };

  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    return { error: "Enter a valid dollar amount with up to two decimals" };
  }

  const [dollarsPart, centsPart = ""] = raw.split(".");
  const amountCents =
    Number(dollarsPart) * 100 + Number(centsPart.padEnd(2, "0"));

  if (amountCents <= 0) {
    return { error: "Credit amount must be greater than $0.00" };
  }

  if (amountCents > MAX_QAML_CREDIT_GRANT_CENTS) {
    return { error: "Credit amount cannot exceed $10,000.00" };
  }

  return { amountCents };
}
