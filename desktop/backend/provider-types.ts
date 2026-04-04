import type {
  DesktopAuthState,
  DesktopModel,
  DesktopModelOption,
  DesktopProvider,
  DesktopProviderOption,
} from "../shared/protocol";

export interface DesktopProviderDefinition {
  id: DesktopProvider;
  label: string;
  transport: "runtime-control-plane";
  option: DesktopProviderOption;
  getDefaultModel(): DesktopModel;
  getAvailableModels(): DesktopModelOption[];
  normalizeModel(value: string | null | undefined): DesktopModel;
  getAuthState(): DesktopAuthState;
  stageRuntimeHome(runtimeHome: string): void;
  buildControlPlaneEnv(model: DesktopModel, controlPlanePort: number): string[];
  buildTurnEnv(model: DesktopModel): Record<string, string>;
}
