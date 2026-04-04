import type { DesktopProvider } from "../shared/protocol";
import type { DesktopProviderDefinition } from "./provider-types";
import { claudeProvider } from "./anthropic";
import { codexProvider } from "./codex";

const PROVIDERS: Record<string, DesktopProviderDefinition> = {
  [claudeProvider.id]: claudeProvider,
  [codexProvider.id]: codexProvider,
};

export function getSupportedDesktopProviders(): DesktopProviderDefinition[] {
  return Object.values(PROVIDERS);
}

export function getDefaultDesktopProvider(): DesktopProviderDefinition {
  if (codexProvider.getAuthState().available && !claudeProvider.getAuthState().available) {
    return codexProvider;
  }
  return claudeProvider;
}

export function getDefaultProvider(): DesktopProvider {
  return getDefaultDesktopProvider().id;
}

export function getDesktopProvider(
  providerId: string | null | undefined,
): DesktopProviderDefinition | null {
  if (!providerId) {
    return null;
  }
  return PROVIDERS[providerId] ?? null;
}

export function requireDesktopProvider(
  providerId: string | null | undefined,
): DesktopProviderDefinition {
  return getDesktopProvider(providerId) ?? getDefaultDesktopProvider();
}

export function getProviderOptions() {
  return getSupportedDesktopProviders().map((provider) => provider.option);
}
