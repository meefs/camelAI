import { describe, expect, it } from "vitest";
import {
  createEmailVerificationToken,
  validateEmailVerificationToken,
} from "@/lib/email-verification-token";

describe("email verification token", () => {
  const secret = "test-signing-secret";

  it("creates and validates a token", async () => {
    const token = await createEmailVerificationToken(secret, {
      user_id: "user-123",
      email: "Test@Example.com",
    });

    const payload = await validateEmailVerificationToken(secret, token);
    expect(payload).not.toBeNull();
    expect(payload?.purpose).toBe("email_verification");
    expect(payload?.user_id).toBe("user-123");
    expect(payload?.email).toBe("test@example.com");
  });

  it("rejects tampered tokens", async () => {
    const token = await createEmailVerificationToken(secret, {
      user_id: "user-123",
      email: "test@example.com",
    });

    const tampered = `${token}x`;
    const payload = await validateEmailVerificationToken(secret, tampered);
    expect(payload).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const token = await createEmailVerificationToken(secret, {
      user_id: "user-123",
      email: "test@example.com",
      issuedAt: Date.now() - 10_000,
      ttlMs: 1_000,
    });

    const payload = await validateEmailVerificationToken(secret, token);
    expect(payload).toBeNull();
  });
});
