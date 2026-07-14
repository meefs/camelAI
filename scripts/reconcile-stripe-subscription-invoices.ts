import { resolve } from "node:path";

interface Options {
  apply: boolean;
  baseUrl: string;
  invoiceIds: string[];
  invoiceFile: string | null;
}

function usage(): string {
  return [
    "Usage:",
    "  ADMIN_API_KEY=... bun run billing:reconcile-invoices -- \\",
    "    --base-url https://staging.camelai.dev --invoice-file ./invoice-ids.txt",
    "",
    "Options:",
    "  --invoice-id <id>    Add an invoice ID (repeatable)",
    "  --invoice-file <p>   Read newline-separated IDs or a JSON string array",
    "  --base-url <url>     Worker base URL (or BILLING_ADMIN_BASE_URL)",
    "  --apply              Apply through the production invoice ledger RPC",
    "  --help               Show this help",
    "",
    "The default mode is dry-run. At most 100 invoice IDs are accepted per run.",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    apply: false,
    baseUrl: process.env.BILLING_ADMIN_BASE_URL?.trim() ?? "",
    invoiceIds: [],
    invoiceFile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--base-url") {
      options.baseUrl = argv[++index]?.trim() ?? "";
      continue;
    }
    if (arg === "--invoice-id") {
      const invoiceId = argv[++index]?.trim();
      if (invoiceId) options.invoiceIds.push(invoiceId);
      continue;
    }
    if (arg === "--invoice-file") {
      options.invoiceFile = argv[++index]?.trim() ?? null;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    if (arg.trim()) options.invoiceIds.push(arg.trim());
  }
  return options;
}

async function readInvoiceFile(path: string): Promise<string[]> {
  const contents = await Bun.file(resolve(path)).text();
  const trimmed = contents.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      throw new Error("Invoice JSON must be an array of strings.");
    }
    return parsed.map((value) => value.trim()).filter(Boolean);
  }
  return trimmed
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value && !value.startsWith("#"));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ADMIN_API_KEY?.trim();
  if (!apiKey) throw new Error("ADMIN_API_KEY is required.");
  if (!options.baseUrl) {
    throw new Error("--base-url or BILLING_ADMIN_BASE_URL is required.");
  }
  if (options.invoiceFile) {
    options.invoiceIds.push(...(await readInvoiceFile(options.invoiceFile)));
  }
  const invoiceIds = [...new Set(options.invoiceIds)];
  if (invoiceIds.length === 0) throw new Error("At least one invoice ID is required.");
  if (invoiceIds.length > 100)
    throw new Error("At most 100 invoice IDs may be reconciled per run.");

  const endpoint = `${options.baseUrl.replace(/\/$/, "")}/api/admin/billing/reconcile-subscription-invoices`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ invoice_ids: invoiceIds, apply: options.apply }),
  });
  const body = (await response.json()) as {
    error?: string;
    mode?: string;
    results?: Array<Record<string, unknown>>;
  };
  if (!response.ok) {
    throw new Error(body.error ?? `Admin API returned HTTP ${response.status}.`);
  }
  console.log(`Mode: ${body.mode ?? (options.apply ? "apply" : "dry-run")}`);
  for (const result of body.results ?? []) console.log(JSON.stringify(result));
  if ((body.results ?? []).some((result) => result.status === "failed")) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 1;
});
