import { describe, expect, it } from "vitest";
import {
  createPasswordResetToken,
  validatePasswordResetToken,
} from "@/lib/password-reset-token";

describe("password reset token", () => {
  const secret = "test-signing-secret";

  it("creates and validates a token", async () => {
    const token = await createPasswordResetToken(secret, {
      user_id: "user-123",
      email: "Test@Example.com",
      nonce: "nonce-abc",
    });

    const payload = await validatePasswordResetToken(secret, token);
    expect(payload).not.toBeNull();
    expect(payload?.purpose).toBe("password_reset");
    expect(payload?.user_id).toBe("user-123");
    expect(payload?.email).toBe("test@example.com");
    expect(payload?.nonce).toBe("nonce-abc");
  });

  it("rejects tampered tokens", async () => {
    const token = await createPasswordResetToken(secret, {
      user_id: "user-123",
      email: "test@example.com",
      nonce: "nonce-abc",
    });

    expect(await validatePasswordResetToken(secret, `${token}x`)).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const token = await createPasswordResetToken(secret, {
      user_id: "user-123",
      email: "test@example.com",
      nonce: "nonce-abc",
      issuedAt: Date.now() - 10_000,
      ttlMs: 1_000,
    });

    expect(await validatePasswordResetToken(secret, token)).toBeNull();
  });

  it("rejects tokens issued for longer than 15 minutes", async () => {
    const token = await createPasswordResetToken(secret, {
      user_id: "user-123",
      email: "test@example.com",
      nonce: "nonce-abc",
      ttlMs: 16 * 60 * 1000,
    });

    expect(await validatePasswordResetToken(secret, token)).toBeNull();
  });

  it("rejects email verification tokens", async () => {
    expect(
      await validatePasswordResetToken(secret, "ev_not-a-password-reset"),
    ).toBeNull();
  });
});
