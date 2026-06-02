import type { OnboardingPreferences } from "../../../../src/types";

export function toOnboardingPreferences(
  raw: unknown,
): OnboardingPreferences | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = raw as Partial<OnboardingPreferences> & Record<string, unknown>;
  const completedAt =
    typeof value.completed_at === "number" || value.completed_at === null
      ? value.completed_at
      : null;
  return {
    completed_at: completedAt ?? null,
  };
}

export function getDefaultOnboardingPreferences(): OnboardingPreferences {
  return {
    completed_at: null,
  };
}

function normalizeCompletedAt(
  value: OnboardingPreferences["completed_at"],
): OnboardingPreferences["completed_at"] {
  if (value === null) {
    return null;
  }

  return Number.isFinite(value) ? value : null;
}

export function sanitizeOnboardingPreferences(
  input: OnboardingPreferences,
): OnboardingPreferences {
  const next =
    toOnboardingPreferences(input) ?? getDefaultOnboardingPreferences();
  return {
    completed_at: normalizeCompletedAt(next.completed_at),
  };
}
