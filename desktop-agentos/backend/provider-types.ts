import type {
  DesktopAuthState,
  DesktopModel,
  DesktopModelOption,
  DesktopProvider,
  DesktopProviderOption,
} from "../../desktop/shared/protocol";

export interface DesktopProviderDefinition {
  id: DesktopProvider;
  label: string;
  transport: "agentos";
  option: DesktopProviderOption;
  getDefaultModel(): DesktopModel;
  getAvailableModels(): DesktopModelOption[];
  normalizeModel(value: string | null | undefined): DesktopModel;
  getAuthState(model?: DesktopModel): DesktopAuthState;
  buildSessionEnv(model: DesktopModel): Record<string, string>;
  getThoughtLevel(): string;
}
