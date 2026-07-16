import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface StagingActor {
  userId: string;
  orgId: string;
  workspaceId: string;
  email: string;
}

export interface BillingSnapshot {
  org_id?: string;
  billing_plan?: string | null;
  billing_status?: string | null;
  billing_subscription_status?: string | null;
  available_credits_cents?: number;
  purchased_credits_cents?: number;
  [key: string]: unknown;
}

interface AdminJsExecEnvelope<T> {
  ok?: boolean;
  success?: boolean;
  result?: T;
  output?: T;
  structuredContent?: T;
  content?: Array<{ type?: string; text?: string }>;
  error?: string;
}

function parseJsonCandidate(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("admin_js_exec returned no output");

  try {
    return JSON.parse(trimmed);
  } catch {
    // Some mcporter versions print a short status line before the JSON value.
    const firstObject = trimmed.indexOf("{");
    const lastObject = trimmed.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) {
      return JSON.parse(trimmed.slice(firstObject, lastObject + 1));
    }
    throw new Error(`Could not parse mcporter output: ${trimmed.slice(0, 500)}`);
  }
}

function unwrapToolResult<T>(raw: unknown, depth = 0): T {
  if (depth > 6) {
    throw new Error("admin_js_exec returned an unexpectedly nested response");
  }
  if (!raw || typeof raw !== "object") return raw as T;
  const envelope = raw as AdminJsExecEnvelope<T>;
  if (envelope.error) throw new Error(envelope.error);
  if (envelope.success === false || envelope.ok === false) {
    throw new Error(`admin_js_exec reported failure: ${JSON.stringify(raw).slice(0, 2_000)}`);
  }
  if (envelope.result !== undefined) {
    return unwrapToolResult<T>(envelope.result, depth + 1);
  }
  if (envelope.structuredContent !== undefined) {
    return unwrapToolResult<T>(envelope.structuredContent, depth + 1);
  }

  const textPart = envelope.content?.find(
    (part) => part.type === "text" && typeof part.text === "string",
  );
  if (textPart?.text) {
    return unwrapToolResult<T>(parseJsonCandidate(textPart.text), depth + 1);
  }
  if (envelope.output !== undefined) {
    return unwrapToolResult<T>(envelope.output, depth + 1);
  }
  return raw as T;
}

function normalizeActor(raw: unknown, email: string): StagingActor {
  const source = unwrapToolResult<Record<string, unknown>>(raw);
  const userId = String(source.userId ?? source.user_id ?? "");
  const orgId = String(source.orgId ?? source.org_id ?? "");
  const workspaceId = String(source.workspaceId ?? source.workspace_id ?? "");
  if (!userId || !orgId || !workspaceId) {
    throw new Error(
      `IDENTITY.createActor returned incomplete ids: ${JSON.stringify(source)}`,
    );
  }
  return { userId, orgId, workspaceId, email };
}

/**
 * Serial client for the staging Admin MCP console. Every method is a separate
 * remote execution so tests never rely on console-local state surviving.
 */
export class StagingAdminClient {
  readonly server: string;
  readonly timeoutMs: number;

  constructor(options?: { server?: string; timeoutMs?: number }) {
    this.server = options?.server ?? process.env.STAGING_ADMIN_MCP ?? "admin-staging";
    this.timeoutMs = options?.timeoutMs ?? 120_000;
  }

  async execute<T>(code: string, input: Record<string, unknown> = {}): Promise<T> {
    const command = process.env.MCPORTER_BIN || "bunx";
    const commandArgs = command === "bunx" ? ["mcporter"] : [];
    commandArgs.push(
      "call",
      `${this.server}.admin_js_exec`,
      `code:=${code}`,
      `input:=${JSON.stringify(input)}`,
      `timeout_ms=${this.timeoutMs}`,
      "max_output_characters=120000",
    );

    try {
      const { stdout } = await execFileAsync(command, commandArgs, {
        timeout: this.timeoutMs + 15_000,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
      });
      return unwrapToolResult<T>(parseJsonCandidate(stdout));
    } catch (error) {
      const detail = error as Error & { stderr?: string; stdout?: string };
      const output = [detail.message, detail.stderr, detail.stdout]
        .filter(Boolean)
        .join("\n")
        .slice(0, 4_000);
      throw new Error(`admin_js_exec via ${this.server} failed:\n${output}`);
    }
  }

  async preflight(): Promise<void> {
    await this.execute(
      `
        assert.ok(runtime.baseUrl.includes("staging"), "Refusing non-staging target");
        assert.equal(runtime.stripeMode, "test", "Stripe must be in test mode");
        assert.ok(typeof IDENTITY?.createActor === "function", "IDENTITY.createActor unavailable");
        assert.ok(typeof IDENTITY?.deleteActor === "function", "IDENTITY.deleteActor unavailable");
        assert.ok(typeof BILLING?.snapshot === "function", "BILLING.snapshot unavailable");
        assert.ok(typeof BILLING?.setAvailableCredits === "function", "BILLING.setAvailableCredits unavailable");
        return { ok: true };
      `,
    );
  }

  async createActor(input: {
    email: string;
    password: string;
    name: string;
  }): Promise<StagingActor> {
    const result = await this.execute<Record<string, unknown>>(
      `return await IDENTITY.createActor({
        email: input.email,
        password: input.password,
        name: input.name,
      });`,
      input,
    );
    return normalizeActor(result, input.email);
  }

  async snapshot(orgId: string): Promise<BillingSnapshot> {
    return this.execute<BillingSnapshot>(
      "return await BILLING.snapshot(input.orgId);",
      { orgId },
    );
  }

  async setAvailableCredits(
    orgId: string,
    cents: number,
  ): Promise<{ orgId: string; previous: BillingSnapshot; current: BillingSnapshot }> {
    return this.execute(
      "return await BILLING.setAvailableCredits(input.orgId, input.cents);",
      { orgId, cents },
    );
  }

  async deleteActor(userId: string): Promise<void> {
    await this.execute(
      "await IDENTITY.deleteActor(input.userId); return { deleted: true };",
      { userId },
    );
  }

  async deleteTestCustomer(orgId: string): Promise<void> {
    await this.execute(
      `if (typeof BILLING.deleteTestCustomer === "function") {
        await BILLING.deleteTestCustomer(input.orgId);
      }
      return { deleted: true };`,
      { orgId },
    );
  }
}
