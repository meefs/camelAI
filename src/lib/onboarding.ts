import type { OnboardingPreferences } from '@/types';

export function hasCompletedOnboarding(
  onboarding: OnboardingPreferences | null | undefined
): boolean {
  return Boolean(onboarding?.completed_at);
}
