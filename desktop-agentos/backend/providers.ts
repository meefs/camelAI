import type { DesktopProvider } from "../../desktop/shared/protocol";
import type { DesktopProviderDefinition } from "./provider-types";
import { agentOsProvider } from "./agentos";

const PROVIDERS: Record<string, DesktopProviderDefinition> = {
  [agentOsProvider.id]: agentOsProvider,
};

export function getSupportedDesktopProviders(): DesktopProviderDefinition[] {
  return Object.values(PROVIDERS);
}

export function getDefaultDesktopProvider(): DesktopProviderDefinition {
  return agentOsProvider;
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
