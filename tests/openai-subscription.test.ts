import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENAI_CODEX_AUTH_ORIGIN,
  OPENAI_CODEX_OAUTH_CLIENT_ID,
  getOpenAiSubscriptionIdentity,
  pollOpenAiDeviceAuthorization,
  refreshOpenAiSubscriptionCredentials,
  startOpenAiDeviceAuthorization,
} from "@/lib/openai-subscription.server";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI subscription device authentication", () => {
  it("starts the Codex public-client device flow", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      device_auth_id: "device-1",
      user_code: "ABCD-EFGH",
      interval: 7,
      expires_in: 600,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await startOpenAiDeviceAuthorization();

    expect(result).toMatchObject({
      deviceAuthId: "device-1",
      userCode: "ABCD-EFGH",
      intervalSeconds: 7,
      verificationUrl: `${OPENAI_CODEX_AUTH_ORIGIN}/codex/device`,
    });
    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(requestInit.body as string)).toEqual({
      client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
    });
  });

  it("treats the documented polling statuses as pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    await expect(pollOpenAiDeviceAuthorization("device-1", "CODE"))
      .resolves.toEqual({ status: "pending" });
  });

  it("exchanges an approved device code and extracts workspace identity", async () => {
    const accessToken = jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
        chatgpt_plan_type: "plus",
      },
    });
    const idToken = jwt({ email: "person@example.com" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        authorization_code: "authorization-code",
        code_verifier: "verifier",
      }))
      .mockResolvedValueOnce(Response.json({
        access_token: accessToken,
        refresh_token: "refresh-1",
        id_token: idToken,
        expires_in: 3600,
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollOpenAiDeviceAuthorization("device-1", "CODE");

    expect(result).toMatchObject({
      status: "complete",
      identity: {
        accountId: "account-1",
        email: "person@example.com",
        planType: "plus",
      },
      credentials: {
        access_token: accessToken,
        refresh_token: "refresh-1",
        account_id: "account-1",
      },
    });
    const tokenBody = fetchMock.mock.calls[1]![1]!.body as URLSearchParams;
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("client_id")).toBe(OPENAI_CODEX_OAUTH_CLIENT_ID);
  });

  it("rotates refresh tokens and retains the old one when OpenAI omits a replacement", async () => {
    const accessToken = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      access_token: accessToken,
      expires_in: 1800,
    })));

    const result = await refreshOpenAiSubscriptionCredentials({
      access_token: "old-access",
      refresh_token: "old-refresh",
      account_id: "account-1",
      expires_at: 1,
    });

    expect(result.credentials.refresh_token).toBe("old-refresh");
    expect(result.credentials.access_token).toBe(accessToken);
  });

  it("reads identity claims from the namespaced ChatGPT auth claim", () => {
    expect(getOpenAiSubscriptionIdentity(jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-2",
        chatgpt_plan_type: "business",
      },
    }), jwt({ email: "admin@example.com" }))).toEqual({
      accountId: "account-2",
      email: "admin@example.com",
      planType: "business",
    });
  });
});
