import { useEffect } from "react";
import {
  redirect,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
} from "react-router";
import { Star } from "lucide-react";
import { toast } from "sonner";
import type { Route } from "./+types/_app.settings.organization.models";
import { ModelLogo } from "@/components/model-logo";
import { SettingsHeader } from "@/components/settings/settings-header";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { getContrastTextColor } from "@/lib/avatar";
import {
  getAuthEnv,
  requireAuthContext,
  requireOrgAdmin,
} from "@/lib/auth.server";
import { listOrgWorkspaces } from "@/lib/auth-do";
import { getEnv } from "@/lib/cloudflare.server";
import {
  ALL_LLM_MODELS,
  MODEL_CATALOG,
  resolveModelPickerCatalog,
  sortAdditionalModelCatalogEntries,
  type ModelCatalogEntry,
} from "@/lib/model-catalog";
import { resolveEffectivePickerConfig } from "@/lib/model-picker-config";
import {
  getStoredCustomLlmProviderApi,
  getStoredCustomLlmProviderModelId,
  getStoredBedrockAwsRegion,
  getVisibleLlmModelOptions,
  isLlmModel,
  type CustomLlmProviderApi,
} from "@/lib/llm-provider-config";
import { getEffectiveLlmProviderConfig } from "@/lib/selfhost-ai-provider";
import { cn } from "@/lib/utils";
import type {
  LlmModel,
  ModelPickerModelConfig,
  OrgModelPickerConfig,
  Workspace,
  WorkspaceModelPickerConfig,
} from "@/types";

type Scope = "org" | "ws";
type Source = "default" | "custom";

const SOURCE_SEGMENTS = {
  org: [
    { value: "default", label: "camelAI defaults" },
    { value: "custom", label: "Custom list" },
  ],
  ws: [
    { value: "default", label: "Follow org" },
    { value: "custom", label: "Custom list" },
  ],
} as const satisfies Record<Scope, readonly { value: Source; label: string }[]>;

interface LoaderWorkspace {
  id: string;
  name: string;
  avatarColor: string;
  avatarContent: string;
  hasCustomConfig: boolean;
}

interface PickerModelRow {
  entry: ModelCatalogEntry;
  addedAt: number;
  isDefault: boolean;
}

interface ActionResponse {
  success?: boolean;
  error?: string;
  message?: string;
}

type ActionTarget =
  | {
      scope: "org";
      config: OrgModelPickerConfig;
      visibleModelIds: Set<LlmModel>;
      save: (
        config: OrgModelPickerConfig,
        details: Record<string, unknown>,
      ) => Promise<OrgModelPickerConfig>;
    }
  | {
      scope: "ws";
      workspace: Workspace;
      orgConfig: OrgModelPickerConfig;
      config: WorkspaceModelPickerConfig;
      visibleModelIds: Set<LlmModel>;
      save: (
        config: WorkspaceModelPickerConfig,
        details: Record<string, unknown>,
      ) => Promise<WorkspaceModelPickerConfig>;
    };

export function meta() {
  return [
    { title: "Models - Settings - camelAI" },
    {
      name: "description",
      content: "Choose which models appear in your team's picker.",
    },
  ];
}

function getScope(url: URL): Scope {
  return url.searchParams.get("scope") === "ws" ? "ws" : "org";
}

function getWorkspaceStub(
  authEnv: ReturnType<typeof getAuthEnv>,
  workspaceId: string,
) {
  return authEnv.WORKSPACE.get(authEnv.WORKSPACE.idFromName(workspaceId));
}

function buildPickerRows(
  config: OrgModelPickerConfig,
  visibleModelIds: ReadonlySet<LlmModel>,
  options: {
    experimentalSettings: import("@/types").OrganizationExperimentalSettings;
    llmProvider: string | null | undefined;
    customApi?: CustomLlmProviderApi | null;
    customModelId?: string | null;
    awsRegion?: string | null;
  },
): PickerModelRow[] {
  return resolveModelPickerCatalog({
    effectiveConfig: { ...config, source: "org" },
    experimentalSettings: options.experimentalSettings,
    orgProvider: options.llmProvider,
    customApi: options.customApi,
    customModelId: options.customModelId,
    awsRegion: options.awsRegion,
  })
    .filter((entry) => visibleModelIds.has(entry.id))
    .map((entry) => ({
      entry,
      addedAt: entry.addedAt,
      isDefault:
        config.use_platform_defaults === false &&
        entry.id === config.default_model,
    }));
}

function buildAdditionalRows(
  config: Pick<OrgModelPickerConfig, "models" | "use_platform_defaults">,
  visibleModelIds: ReadonlySet<LlmModel>,
): ModelCatalogEntry[] {
  if (config.use_platform_defaults !== false) return [];
  const inPicker = new Set(config.models.map((model) => model.id));
  return sortAdditionalModelCatalogEntries(
    ALL_LLM_MODELS.filter(
      (id) => visibleModelIds.has(id) && !inPicker.has(id),
    ).map((id) => MODEL_CATALOG[id]),
  );
}

async function loadWorkspaceConfigs(
  authEnv: ReturnType<typeof getAuthEnv>,
  workspaces: Workspace[],
): Promise<Map<string, WorkspaceModelPickerConfig>> {
  const entries = await Promise.all(
    workspaces.map(async (workspace) => {
      const config = await getWorkspaceStub(authEnv, workspace.id)
        .getModelPickerConfig()
        .catch(() => ({
          use_org_defaults: true,
          models: [],
          default_model: null,
        }));
      return [workspace.id, config] as const;
    }),
  );
  return new Map(entries);
}

function requireWorkspaceInOrg(
  workspaceId: string | null,
  workspaces: Workspace[],
): Workspace {
  const workspace = workspaces.find((item) => item.id === workspaceId);
  if (!workspace) {
    throw redirect("/settings/organization/models");
  }
  return workspace;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgId = authContext.currentOrg.id;
  const url = new URL(request.url);
  const scope = getScope(url);
  const selectedWorkspaceId = url.searchParams.get("workspaceId");

  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const [orgConfig, workspaces] = await Promise.all([
    orgStub.getModelPickerConfig(),
    listOrgWorkspaces(authEnv, orgId),
  ]);
  const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
    env,
    authContext.currentOrgLlmProviderConfig,
  );
  const experimentalSettings = authContext.currentOrgExperimentalSettings;
  const customApi = getStoredCustomLlmProviderApi(effectiveLlmProviderConfig);
  const customModelId = getStoredCustomLlmProviderModelId(
    effectiveLlmProviderConfig,
  );
  const awsRegion = getStoredBedrockAwsRegion(effectiveLlmProviderConfig);
  const visibleModelIds = getVisibleModelIdsForSettings(
    effectiveLlmProviderConfig?.provider,
    experimentalSettings,
    customApi,
    customModelId,
    awsRegion,
  );
  const workspaceConfigs = await loadWorkspaceConfigs(authEnv, workspaces);
  const selectedWorkspace =
    scope === "ws"
      ? requireWorkspaceInOrg(selectedWorkspaceId, workspaces)
      : null;
  const workspaceConfig = selectedWorkspace
    ? (workspaceConfigs.get(selectedWorkspace.id) ?? null)
    : null;
  const effectiveConfig =
    scope === "ws"
      ? resolveEffectivePickerConfig(orgConfig, workspaceConfig)
      : { ...orgConfig, source: "org" as const };
  const displayConfig = normalizeConfigForVisibleModels(
    effectiveConfig,
    visibleModelIds,
  );
  const pickerRows = buildPickerRows(displayConfig, visibleModelIds, {
    experimentalSettings,
    llmProvider: effectiveLlmProviderConfig?.provider,
    customApi,
    customModelId,
    awsRegion,
  });
  const useOrgDefaults =
    scope === "ws" ? (workspaceConfig?.use_org_defaults ?? true) : false;

  return {
    scope,
    selectedWorkspaceId: selectedWorkspace?.id ?? null,
    workspaces: workspaces.map<LoaderWorkspace>((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      avatarColor: workspace.avatar.color,
      avatarContent: workspace.avatar.content,
      hasCustomConfig:
        workspaceConfigs.get(workspace.id)?.use_org_defaults === false,
    })),
    useOrgDefaults,
    config: {
      usePlatformDefaults: displayConfig.use_platform_defaults !== false,
      inPicker: pickerRows,
      additional: buildAdditionalRows(displayConfig, visibleModelIds),
      capacity: {
        used: pickerRows.length,
        max: visibleModelIds.size,
      },
    },
  };
}

async function loadActionTarget(args: {
  request: Request;
  context: Route.ActionArgs["context"];
}): Promise<ActionTarget> {
  const authContext = await requireAuthContext(args.request, args.context);
  await requireOrgAdmin(args.request, args.context, authContext.currentOrg.id);
  const env = getEnv(args.context);
  const authEnv = getAuthEnv(env);
  const orgId = authContext.currentOrg.id;
  const url = new URL(args.request.url);
  const scope = getScope(url);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
    env,
    authContext.currentOrgLlmProviderConfig,
  );
  const experimentalSettings = authContext.currentOrgExperimentalSettings;
  const visibleModelIds = getVisibleModelIdsForSettings(
    effectiveLlmProviderConfig?.provider,
    experimentalSettings,
    getStoredCustomLlmProviderApi(effectiveLlmProviderConfig),
    getStoredCustomLlmProviderModelId(effectiveLlmProviderConfig),
    getStoredBedrockAwsRegion(effectiveLlmProviderConfig),
  );

  if (scope === "org") {
    return {
      scope,
      config: await orgStub.getModelPickerConfig(),
      visibleModelIds,
      save: async (
        config: OrgModelPickerConfig,
        details: Record<string, unknown>,
      ) =>
        await orgStub.setModelPickerConfig(config, {
          actorId: authContext.user.id,
          details,
        }),
    };
  }

  const workspaces = await listOrgWorkspaces(authEnv, orgId);
  const workspace = requireWorkspaceInOrg(
    url.searchParams.get("workspaceId"),
    workspaces,
  );
  const workspaceStub = getWorkspaceStub(authEnv, workspace.id);
  const [orgConfig, workspaceConfig] = await Promise.all([
    orgStub.getModelPickerConfig(),
    workspaceStub.getModelPickerConfig(),
  ]);

  return {
    scope,
    workspace,
    orgConfig,
    config: workspaceConfig,
    visibleModelIds,
    save: (
      config: WorkspaceModelPickerConfig,
      details: Record<string, unknown>,
    ) =>
      workspaceStub.setModelPickerConfig(config, {
        actorId: authContext.user.id,
        details,
      }),
  };
}

function response(payload: ActionResponse, init?: ResponseInit) {
  return Response.json(payload, init);
}

async function saveActionTarget(
  target: ActionTarget,
  config: OrgModelPickerConfig | WorkspaceModelPickerConfig,
  details: Record<string, unknown>,
) {
  if (target.scope === "org") {
    return target.save(config as OrgModelPickerConfig, details);
  }
  return target.save(config as WorkspaceModelPickerConfig, details);
}

function modelLabel(model: LlmModel): string {
  return MODEL_CATALOG[model].label;
}

function addModel(
  models: readonly ModelPickerModelConfig[],
  model: LlmModel,
): ModelPickerModelConfig[] {
  if (models.some((item) => item.id === model)) {
    return [...models];
  }
  return [{ id: model, added_at: Date.now() }, ...models];
}

function visibleModelRows(
  config: Pick<OrgModelPickerConfig, "models" | "use_platform_defaults">,
  visibleModelIds: ReadonlySet<LlmModel>,
): ModelPickerModelConfig[] {
  if (config.use_platform_defaults === false) {
    return config.models
      .filter((model) => visibleModelIds.has(model.id))
      .map((model) => ({ ...model }));
  }

  return sortAdditionalModelCatalogEntries(
    ALL_LLM_MODELS.filter((id) => visibleModelIds.has(id)).map(
      (id) => MODEL_CATALOG[id],
    ),
  ).map((entry, index) => ({ id: entry.id, added_at: Date.now() - index }));
}

function getVisibleModelIdsForSettings(
  llmProvider: string | null | undefined,
  experimentalSettings: import("@/types").OrganizationExperimentalSettings,
  customApi?: CustomLlmProviderApi | null,
  customModelId?: string | null,
  awsRegion?: string | null,
): Set<LlmModel> {
  return new Set(
    getVisibleLlmModelOptions(experimentalSettings, null, {
      orgProvider: llmProvider,
      customApi,
      customModelId,
      awsRegion,
    }).map((option) => option.value),
  );
}

function normalizeConfigForVisibleModels<
  T extends OrgModelPickerConfig | WorkspaceModelPickerConfig,
>(config: T, visibleModelIds: ReadonlySet<LlmModel>): T {
  const models = config.models
    .filter((model) => visibleModelIds.has(model.id))
    .map((model) => ({ ...model }));
  let default_model = config.default_model ?? null;
  if (
    default_model &&
    (!visibleModelIds.has(default_model) ||
      (config.use_platform_defaults === false &&
        !models.some((model) => model.id === default_model)))
  ) {
    default_model = null;
  }
  return { ...config, models, default_model };
}

function customConfigFromRetainedOrSnapshot<
  T extends OrgModelPickerConfig | WorkspaceModelPickerConfig,
>(
  baseConfig: T,
  snapshotConfig: Pick<
    OrgModelPickerConfig,
    "models" | "use_platform_defaults" | "default_model"
  >,
  visibleModelIds: ReadonlySet<LlmModel>,
): { config: T; restoredRetainedList: boolean } {
  const retainedConfig = normalizeConfigForVisibleModels(
    { ...baseConfig, use_platform_defaults: false },
    visibleModelIds,
  );
  if (retainedConfig.models.length > 0) {
    return { config: retainedConfig, restoredRetainedList: true };
  }

  return {
    config: normalizeConfigForVisibleModels(
      {
        ...baseConfig,
        use_platform_defaults: false,
        models: visibleModelRows(snapshotConfig, visibleModelIds),
        default_model:
          snapshotConfig.use_platform_defaults === false
            ? snapshotConfig.default_model
            : null,
      },
      visibleModelIds,
    ),
    restoredRetainedList: false,
  };
}

function validateModelForProvider(
  model: LlmModel,
  visibleModelIds: ReadonlySet<LlmModel>,
): ActionResponse | null {
  if (visibleModelIds.has(model)) return null;
  return { error: `${modelLabel(model)} is not available for this provider` };
}

export async function action({ request, context }: Route.ActionArgs) {
  const target = await loadActionTarget({ request, context });
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "setUseOrgDefaults") {
    if (target.scope !== "ws") {
      return response({ error: "Invalid action for org scope" }, { status: 400 });
    }
    const useOrgDefaults = formData.get("useOrgDefaults") === "true";
    const disablingOrgDefaults =
      !useOrgDefaults && target.config.use_org_defaults;
    const customConfigResult = disablingOrgDefaults
      ? customConfigFromRetainedOrSnapshot(
          target.config,
          target.orgConfig,
          target.visibleModelIds,
        )
      : null;
    const restoredRetainedList =
      customConfigResult?.restoredRetainedList ?? false;
    const nextConfig = customConfigResult
      ? {
          ...customConfigResult.config,
          use_org_defaults: false,
        }
      : {
          ...target.config,
          use_org_defaults: useOrgDefaults,
        };
    await target.save(
      nextConfig,
      {
        intent,
        workspace_id: target.workspace.id,
        use_org_defaults: useOrgDefaults,
        restored_retained_list: restoredRetainedList,
        seeded_from_org_defaults:
          disablingOrgDefaults && !restoredRetainedList,
      },
    );
    return response({
      success: true,
    });
  }

  if (target.scope === "ws" && target.config.use_org_defaults) {
    return response(
      { error: "Turn off org defaults before editing workspace models" },
      { status: 400 },
    );
  }

  const rawModel = formData.get("model");
  const rawModelString = typeof rawModel === "string" ? rawModel : "";
  const model = isLlmModel(rawModelString) ? rawModelString : null;
  const currentConfig = normalizeConfigForVisibleModels(
    target.config,
    target.visibleModelIds,
  );

  if (intent === "setUsePlatformDefaults") {
    const usePlatformDefaults = formData.get("usePlatformDefaults") === "true";
    const nextConfig = usePlatformDefaults
      ? {
          ...target.config,
          use_platform_defaults: true,
        }
      : customConfigFromRetainedOrSnapshot(
          currentConfig,
          currentConfig,
          target.visibleModelIds,
        ).config;
    await saveActionTarget(target, nextConfig, {
      intent,
      use_platform_defaults: usePlatformDefaults,
    });
    return response({
      success: true,
    });
  }

  if (intent === "addModel") {
    if (!model) {
      return response({ error: "A valid model is required" }, { status: 400 });
    }
    const providerError = validateModelForProvider(
      model,
      target.visibleModelIds,
    );
    if (providerError) {
      return response(providerError, { status: 400 });
    }
    await saveActionTarget(
      target,
      {
        ...currentConfig,
        use_platform_defaults: false,
        models: addModel(
          visibleModelRows(currentConfig, target.visibleModelIds),
          model,
        ),
      },
      { intent, model },
    );
    return response({
      success: true,
      message: `Added ${modelLabel(model)} to picker`,
    });
  }

  if (intent === "removeModel") {
    if (!model) {
      return response({ error: "A valid model is required" }, { status: 400 });
    }
    const pickerModels = visibleModelRows(currentConfig, target.visibleModelIds);
    if (target.visibleModelIds.has(model) && pickerModels.length <= 1) {
      return response(
        { error: "Picker must include at least one model available for this provider." },
        { status: 400 },
      );
    }
    const models = pickerModels.filter((item) => item.id !== model);
    const nextConfig = {
      ...currentConfig,
      use_platform_defaults: false,
      models,
      default_model:
        currentConfig.default_model === model
          ? null
          : currentConfig.default_model,
    };
    await saveActionTarget(
      target,
      nextConfig,
      { intent, model },
    );
    return response({
      success: true,
      message: `Removed ${modelLabel(model)} from picker`,
    });
  }

  if (intent === "setDefault") {
    if (rawModelString && !model) {
      return response({ error: "A valid model is required" }, { status: 400 });
    }
  const nextDefault = model;
  if (
    nextDefault &&
      currentConfig.use_platform_defaults === false &&
      !currentConfig.models.some((item) => item.id === nextDefault)
  ) {
      return response({ error: "Default model must be in the picker" }, { status: 400 });
    }
    if (nextDefault) {
      const providerError = validateModelForProvider(
        nextDefault,
        target.visibleModelIds,
      );
      if (providerError) {
        return response(providerError, { status: 400 });
      }
    }
    await saveActionTarget(
      target,
      {
        ...currentConfig,
        default_model: nextDefault,
      },
      { intent, model: nextDefault },
    );
    return response({
      success: true,
      message: nextDefault
        ? `Set ${modelLabel(nextDefault)} as default`
        : "Cleared the default model",
    });
  }

  return response({ error: "Unknown intent" }, { status: 400 });
}

function ModelSettingsRow({
  row,
  actionLabel,
  onAction,
  onDefault,
  editable,
  actionDisabled,
  defaultDisabled,
}: {
  row: PickerModelRow | { entry: ModelCatalogEntry };
  actionLabel: "add" | "remove";
  onAction: (model: LlmModel) => void;
  onDefault?: (model: LlmModel | null) => void;
  editable: boolean;
  actionDisabled?: boolean;
  defaultDisabled?: boolean;
}) {
  const entry = row.entry;
  const isDefault = "isDefault" in row ? row.isDefault : false;

  if (!editable) {
    return (
      <div className="flex min-h-10 items-center gap-2 py-2.5">
        <ModelLogo
          model={entry.id}
          size={16}
          className="size-4 shrink-0 opacity-60"
        />
        <span className="text-sm font-medium text-muted-foreground">
          {entry.label}
        </span>
        {isDefault && (
          <span className="ml-auto text-xs text-muted-foreground">
            default
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-10 items-center gap-2 py-2.5">
      <ModelLogo model={entry.id} size={16} className="size-4 shrink-0" />
      <span className="text-sm font-medium">{entry.label}</span>
      <div className="ml-auto flex items-center gap-1.5">
        {onDefault && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={defaultDisabled ?? actionDisabled}
            onClick={() => onDefault(isDefault ? null : entry.id)}
            aria-label={
              isDefault
                ? `Clear ${entry.label} as default`
                : `Set ${entry.label} as default`
            }
          >
            <Star
              className={cn(
                "size-3.5",
                isDefault && "fill-current text-amber-500",
              )}
            />
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actionDisabled}
          onClick={() => onAction(entry.id)}
        >
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}

export default function OrganizationModelsPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResponse>();
  const navigate = useNavigate();
  const location = useLocation();
  const isSubmitting = fetcher.state !== "idle";
  const pendingSource: Source | null =
    fetcher.formData?.get("intent") === "setUseOrgDefaults"
      ? fetcher.formData.get("useOrgDefaults") === "true"
        ? "default"
        : "custom"
      : fetcher.formData?.get("intent") === "setUsePlatformDefaults"
        ? fetcher.formData.get("usePlatformDefaults") === "true"
          ? "default"
          : "custom"
        : null;
  const derivedSource: Source =
    data.scope === "ws"
      ? data.useOrgDefaults
        ? "default"
        : "custom"
      : data.config.usePlatformDefaults
        ? "default"
        : "custom";
  const source = pendingSource ?? derivedSource;
  const editable = source === "custom";
  const editingCustomList = data.config.usePlatformDefaults === false;
  const orgResolvedDataAvailable = data.useOrgDefaults;
  const sourceDescription =
    data.scope === "org"
      ? source === "default"
        ? "Kept up to date by camelAI. New models appear automatically and retired models are removed."
        : "You manage this list. New models won't be added automatically."
      : source === "custom"
        ? "This workspace has its own list. New models won't be added automatically, and changes to org settings won't affect it."
        : orgResolvedDataAvailable
          ? data.config.usePlatformDefaults
            ? "This workspace follows your org's setting, which is currently camelAI's default lineup."
            : "This workspace follows your org's setting, which is currently a custom list."
          : "This workspace follows your org's setting.";
  // Intentional: the top-level workspace switcher is only useful when admins
  // can choose between multiple workspaces. Single-workspace orgs can still
  // access workspace override controls directly via scope=ws.
  const workspaceSelectorVisible = data.workspaces.length > 1;
  const workspaceControlsVisible =
    workspaceSelectorVisible || data.scope === "ws";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.error) {
      toast.error(fetcher.data.error);
    } else if (fetcher.data.message) {
      toast.success(fetcher.data.message);
    }
  }, [fetcher.data, fetcher.state]);

  function submitForm(fields: Record<string, string>) {
    fetcher.submit(fields, {
      method: "post",
      action: `${location.pathname}${location.search}`,
    });
  }

  function submit(intent: string, model?: LlmModel | null) {
    submitForm({
      intent,
      ...(model !== undefined ? { model: model ?? "" } : {}),
    });
  }

  function submitSource(next: Source) {
    if (data.scope === "ws") {
      submitForm({
        intent: "setUseOrgDefaults",
        useOrgDefaults: String(next === "default"),
      });
      return;
    }
    submitForm({
      intent: "setUsePlatformDefaults",
      usePlatformDefaults: String(next === "default"),
    });
  }

  function navigateScope(value: string) {
    if (!value) return;
    if (value === "org") {
      navigate("/settings/organization/models");
      return;
    }
    navigate(`/settings/organization/models?scope=ws&workspaceId=${value}`);
  }

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Models"
        description="Choose which models appear in your team's picker."
      />

      {workspaceControlsVisible && (
        <div className="space-y-4">
          {workspaceSelectorVisible && (
            <ToggleGroup
              type="single"
              variant="outline"
              value={
                data.scope === "org" ? "org" : data.selectedWorkspaceId ?? ""
              }
              onValueChange={navigateScope}
              className="flex-wrap justify-start"
            >
              <ToggleGroupItem value="org" className="rounded-full px-3">
                Org default
              </ToggleGroupItem>
              {data.workspaces.map((workspace) => (
                <ToggleGroupItem
                  key={workspace.id}
                  value={workspace.id}
                  className="gap-1.5 rounded-full px-3"
                >
                  <Avatar size="xs" className="shrink-0">
                    <AvatarFallback
                      content={workspace.avatarContent}
                      style={{
                        backgroundColor: workspace.avatarColor,
                        color: getContrastTextColor(workspace.avatarColor),
                      }}
                    >
                      {workspace.avatarContent}
                    </AvatarFallback>
                  </Avatar>
                  <span className="max-w-36 truncate">{workspace.name}</span>
                  {workspace.hasCustomConfig && (
                    <>
                      <span
                        aria-hidden
                        className="size-1.5 rounded-full bg-muted-foreground/50"
                      />
                      <span className="sr-only">has custom list</span>
                    </>
                  )}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
        </div>
      )}

      <div className="space-y-2">
        <Tabs
          value={source}
          onValueChange={(value) => submitSource(value as Source)}
          activationMode="manual"
        >
          <TabsList>
            {SOURCE_SEGMENTS[data.scope].map((segment) => (
              <TabsTrigger
                key={segment.value}
                value={segment.value}
                disabled={isSubmitting}
                className="px-3"
              >
                {segment.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <p className="text-sm text-muted-foreground">{sourceDescription}</p>
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">
            {editable ? "In your picker" : "In the picker"}
          </h2>
          <span className="text-sm text-muted-foreground">
            {data.config.capacity.used} of {data.config.capacity.max}
          </span>
        </div>
        {data.config.inPicker.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            {editable
              ? "No models in the picker. Add at least one below for your team to chat."
              : "No models in the picker."}
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {data.config.inPicker.map((row) => (
              <ModelSettingsRow
                key={row.entry.id}
                row={row}
                actionLabel="remove"
                onAction={(model) => submit("removeModel", model)}
                onDefault={(model) => submit("setDefault", model)}
                editable={editable}
                actionDisabled={isSubmitting}
                defaultDisabled={isSubmitting || !editingCustomList}
              />
            ))}
          </div>
        )}
        {!editable && data.config.inPicker.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Switch to a custom list to edit which models appear.
          </p>
        )}
      </section>

      {editable && editingCustomList && (
        <>
          <Separator />

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Additional models</h2>
              <span className="text-sm text-muted-foreground">
                {data.config.additional.length} available
              </span>
            </div>
            {data.config.additional.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">
                Models you remove will show up here.
              </p>
            ) : (
              <div className="divide-y divide-border/60">
                {data.config.additional.map((entry) => (
                  <ModelSettingsRow
                    key={entry.id}
                    row={{ entry }}
                    actionLabel="add"
                    onAction={(model) => submit("addModel", model)}
                    editable
                    actionDisabled={isSubmitting}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
