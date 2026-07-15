import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

describe("admin_js_exec checked-in suites", () => {
  it("parses and executes the read-only staging billing smoke body", async () => {
    const source = readFileSync(
      resolve("scripts/admin-js-exec/staging-billing-smoke.jsbody"),
      "utf8",
    );
    const run = new AsyncFunction(
      "test",
      "assert",
      "runtime",
      "ADMIN",
      "DO",
      "input",
      "text",
      source,
    );
    const test = async (_name: string, operation: () => unknown) => operation();
    const assert = Object.assign(
      (value: unknown, message?: string) => expect(value, message).toBeTruthy(),
      {
        ok: (value: unknown, message?: string) =>
          expect(value, message).toBeTruthy(),
        equal: (actual: unknown, expected: unknown) =>
          expect(actual).toEqual(expected),
      },
    );
    const orgInfo = {
      id: "org_test",
      billing_status: "active",
      billing_plan: "team",
      billing_seat_count: 3,
    };
    const orgStub = {
      getInfo: vi.fn(async () => orgInfo),
      getMemberCount: vi.fn(async () => 2),
      listInvitations: vi.fn(async () => [
        { expires_at: Date.now() + 60_000 },
      ]),
    };
    const text = vi.fn();

    await expect(
      run(
        test,
        assert,
        { baseUrl: "https://staging.camelai.dev", stripeMode: "test" },
        {
          fetch: vi.fn(async () =>
            Response.json({ total_users: 1, total_orgs: 1 }),
          ),
        },
        {
          call: vi.fn(async () => orgInfo),
          stub: vi.fn(() => orgStub),
        },
        { org_id: "org_test" },
        text,
      ),
    ).resolves.toEqual({
      environment: "https://staging.camelai.dev",
      org_id: "org_test",
    });
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ occupied_seats: 3, billing_seat_count: 3 }),
    );
  });
});
