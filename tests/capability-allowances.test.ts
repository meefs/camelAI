import { describe, expect, it } from "vitest";
import {
  CAPABILITY_DAILY_LIMITS,
  getCapabilityAllowancePolicy,
  isHostedCapability,
  nextUtcDayStart,
  utcDayKey,
} from "@/lib/capability-allowances";

describe("capability allowances", () => {
  it("uses one shared capability policy with larger paid-plan limits", () => {
    expect(CAPABILITY_DAILY_LIMITS.free).toEqual({
      web_search: 100,
      web_fetch: 200,
      research: 50,
      oracle: 100,
    });
    expect(CAPABILITY_DAILY_LIMITS.starter.oracle).toBe(500);
    expect(CAPABILITY_DAILY_LIMITS.pro.oracle).toBe(2_000);
    expect(CAPABILITY_DAILY_LIMITS.team).toEqual(CAPABILITY_DAILY_LIMITS.pro);
    expect(CAPABILITY_DAILY_LIMITS.enterprise.oracle).toBeNull();
  });

  it("normalizes legacy plans and validates capability names", () => {
    expect(getCapabilityAllowancePolicy("research", "payg").dailyLimit).toBe(50);
    expect(getCapabilityAllowancePolicy("research", null, "active").dailyLimit).toBe(250);
    expect(getCapabilityAllowancePolicy("oracle", "pro", "active").dailyLimit).toBe(2_000);
    expect(getCapabilityAllowancePolicy("oracle", "pro", "canceled").dailyLimit).toBe(100);
    expect(getCapabilityAllowancePolicy("oracle", "team", "inactive").dailyLimit).toBe(100);
    expect(getCapabilityAllowancePolicy("oracle", "starter", "past_due").dailyLimit).toBe(100);
    expect(getCapabilityAllowancePolicy("oracle", "enterprise", "inactive").dailyLimit).toBe(100);
    expect(getCapabilityAllowancePolicy("oracle", "enterprise", "canceled").dailyLimit).toBe(100);
    expect(getCapabilityAllowancePolicy("oracle", "enterprise", "enterprise").dailyLimit).toBeNull();
    expect(isHostedCapability("web_search")).toBe(true);
    expect(isHostedCapability("browser_search")).toBe(false);
  });

  it("uses UTC calendar-day windows", () => {
    const now = Date.parse("2026-07-15T23:59:59.000Z");
    expect(utcDayKey(now)).toBe("2026-07-15");
    expect(new Date(nextUtcDayStart(now)).toISOString()).toBe(
      "2026-07-16T00:00:00.000Z",
    );
  });
});
