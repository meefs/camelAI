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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  sortAdditionalModelCatalogEntries,
  type ModelCatalogEntry,
} from "@/lib/model-catalog";
import {
  MODEL_PICKER_MAX_MODELS,
  resolveEffectivePickerConfig,
} from "@/lib/model-picker-config";
import {
  getDefaultThreadProvider,
  getVisibleLlmModelOptions,
  isLlmModel,
} from "@/lib/llm-provider-config";
import { cn } from "@/lib/utils";
import type {
  LlmModel,
  ModelPickerModelConfig,
  OrgModelPickerConfig,
  Workspace,
  WorkspaceModelPickerConfig,
} from "@/types";

type Scope = "org" | "ws";

interface LoaderWorkspace {
  id: string;
  name: string;
  avatarColor: string;
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
  config: Pick<OrgModelPickerConfig, "models" | "default_model">,
): PickerModelRow[] {
  return config.models
    .map((model) => ({
      entry: MODEL_CATALOG[model.id],
      addedAt: model.added_at,
      isDefault: model.id === config.default_model,
    }))
    .sort(
      (a, b) =>
        a.entry.providerOrder - b.entry.providerOrder ||
        b.addedAt - a.addedAt ||
        a.entry.label.localeCompare(b.entry.label),
    );
}

function buildAdditionalRows(
  config: Pick<OrgModelPickerConfig, "models">,
): ModelCatalogEntry[] {
  const inPicker = new Set(config.models.map((model) => model.id));
  return sortAdditionalModelCatalogEntries(
    ALL_LLM_MODELS.filter((id) => !inPicker.has(id)).map(
      (id) => MODEL_CATALOG[id],
    ),
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
  const useOrgDefaults =
    scope === "ws" ? (workspaceConfig?.use_org_defaults ?? true) : false;

  return {
    scope,
    selectedWorkspaceId: selectedWorkspace?.id ?? null,
    workspaces: workspaces.map<LoaderWorkspace>((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      avatarColor: workspace.avatar.color,
      hasCustomConfig:
        workspaceConfigs.get(workspace.id)?.use_org_defaults === false,
    })),
    useOrgDefaults,
    config: {
      inPicker: buildPickerRows(effectiveConfig),
      additional: buildAdditionalRows(effectiveConfig),
      capacity: {
        used: effectiveConfig.models.length,
        max: MODEL_PICKER_MAX_MODELS,
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
  const [llmProviderConfig, experimentalSettings] = await Promise.all([
    orgStub.getLlmProviderConfig().catch(() => null),
    orgStub
      .getExperimentalSettings()
      .catch(() => ({ claude_proxy_models: false })),
  ]);
  const visibleModelIds = getVisibleModelIdsForSettings(
    llmProviderConfig?.provider,
    experimentalSettings,
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

function getVisibleModelIdsForSettings(
  llmProvider: string | null | undefined,
  experimentalSettings: import("@/types").OrganizationExperimentalSettings,
): Set<LlmModel> {
  const provider = getDefaultThreadProvider(llmProvider, experimentalSettings);
  return new Set(
    getVisibleLlmModelOptions(provider, experimentalSettings, null, {
      allowModelFamilySwitch: true,
      orgProvider: llmProvider,
    }).map((option) => option.value),
  );
}

function normalizeConfigForVisibleModels<
  T extends OrgModelPickerConfig | WorkspaceModelPickerConfig,
>(config: T, visibleModelIds: ReadonlySet<LlmModel>): T {
  const models = config.models
    .filter((model) => visibleModelIds.has(model.id))
    .map((model) => ({ ...model }));
  const default_model =
    config.default_model && visibleModelIds.has(config.default_model)
      ? config.default_model
      : (models[0]?.id ?? null);
  return { ...config, models, default_model };
}

function hasVisibleModel(
  config: Pick<OrgModelPickerConfig, "models">,
  visibleModelIds: ReadonlySet<LlmModel>,
): boolean {
  return config.models.some((model) => visibleModelIds.has(model.id));
}

function validateModelForProvider(
  model: LlmModel,
  visibleModelIds: ReadonlySet<LlmModel>,
): ActionResponse | null {
  if (visibleModelIds.has(model)) return null;
  return { error: `${modelLabel(model)} is not available for this provider` };
}

function validateConfigForProvider(
  config: Pick<OrgModelPickerConfig, "models">,
  visibleModelIds: ReadonlySet<LlmModel>,
): ActionResponse | null {
  if (config.models.length === 0 || hasVisibleModel(config, visibleModelIds)) {
    return null;
  }
  return {
    error:
      "Picker must include at least one model available for this provider, or be empty.",
  };
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
    const nextConfig =
      !useOrgDefaults && target.config.use_org_defaults
        ? normalizeConfigForVisibleModels(
            {
              use_org_defaults: false,
              models: target.orgConfig.models,
              default_model: target.orgConfig.default_model,
            },
            target.visibleModelIds,
          )
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
        seeded_from_org_defaults:
          !useOrgDefaults && target.config.use_org_defaults,
      },
    );
    return response({
      success: true,
      message: useOrgDefaults
        ? "Workspace is using org defaults"
        : "Workspace model overrides enabled",
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
    if (
      target.config.models.length >= MODEL_PICKER_MAX_MODELS &&
      !target.config.models.some((item) => item.id === model)
    ) {
      return response({ error: "Picker capacity reached" }, { status: 400 });
    }
    await saveActionTarget(
      target,
      {
        ...target.config,
        models: addModel(target.config.models, model),
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
    const models = target.config.models.filter((item) => item.id !== model);
    const nextConfig = {
      ...target.config,
      models,
      default_model:
        target.config.default_model === model
          ? null
          : target.config.default_model,
    };
    const providerError = validateConfigForProvider(
      nextConfig,
      target.visibleModelIds,
    );
    if (providerError) {
      return response(providerError, { status: 400 });
    }
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
      !target.config.models.some((item) => item.id === nextDefault)
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
        ...target.config,
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
  readOnly,
  disabled,
  capacityReached,
}: {
  row: PickerModelRow | { entry: ModelCatalogEntry };
  actionLabel: "add" | "remove";
  onAction: (model: LlmModel) => void;
  onDefault?: (model: LlmModel | null) => void;
  readOnly?: boolean;
  disabled?: boolean;
  capacityReached?: boolean;
}) {
  const entry = row.entry;
  const isDefault = "isDefault" in row ? row.isDefault : false;
  const actionButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={readOnly || disabled || (actionLabel === "add" && capacityReached)}
      onClick={() => onAction(entry.id)}
    >
      {actionLabel}
    </Button>
  );

  return (
    <div className="flex min-h-9 items-center gap-2 py-1">
      <ModelLogo model={entry.id} size={16} className="size-4" />
      <span className="text-sm font-medium">{entry.label}</span>
      <div className="ml-auto flex items-center gap-1.5">
        {onDefault && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={readOnly || disabled}
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
        {actionLabel === "add" && capacityReached ? (
          <Tooltip>
            <TooltipTrigger asChild>{actionButton}</TooltipTrigger>
            <TooltipContent>Picker capacity reached (max 10)</TooltipContent>
          </Tooltip>
        ) : (
          actionButton
        )}
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
  const readOnly = data.scope === "ws" && data.useOrgDefaults;
  const capacityReached = data.config.capacity.used >= data.config.capacity.max;
  const workspaceSelectorVisible = data.workspaces.length > 0;
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

  function submit(intent: string, model?: LlmModel | null) {
    fetcher.submit(
      {
        intent,
        ...(model !== undefined ? { model: model ?? "" } : {}),
      },
      { method: "post", action: `${location.pathname}${location.search}` },
    );
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
              <ToggleGroupItem value="org" className="h-11 px-3">
                <span className="leading-tight">Org default</span>
              </ToggleGroupItem>
              {data.workspaces.map((workspace) => (
                <ToggleGroupItem
                  key={workspace.id}
                  value={workspace.id}
                  className="h-11 gap-2 px-3"
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: workspace.avatarColor }}
                  />
                  <span className="max-w-36 truncate">{workspace.name}</span>
                  {workspace.hasCustomConfig && (
                    <Badge variant="secondary">CUSTOM</Badge>
                  )}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}

          {data.scope === "ws" && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={data.useOrgDefaults}
                disabled={isSubmitting}
                onCheckedChange={(checked) => {
                  fetcher.submit(
                    {
                      intent: "setUseOrgDefaults",
                      useOrgDefaults: checked === true ? "true" : "false",
                    },
                    {
                      method: "post",
                      action: `${location.pathname}${location.search}`,
                    },
                  );
                }}
              />
              Use org defaults for this workspace
            </label>
          )}
        </div>
      )}

      {readOnly && (
        <p className="text-sm text-muted-foreground">
          Inheriting from org defaults. Turn off the toggle to customize.
        </p>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">In your picker</h2>
          <span className="text-sm text-muted-foreground">
            {data.config.capacity.used} of {data.config.capacity.max}
          </span>
        </div>
        {data.config.inPicker.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No models in the picker. Add at least one below for your team to chat.
          </p>
        ) : (
          data.config.inPicker.map((row) => (
            <ModelSettingsRow
              key={row.entry.id}
              row={row}
              actionLabel="remove"
              onAction={(model) => submit("removeModel", model)}
              onDefault={(model) => submit("setDefault", model)}
              readOnly={readOnly}
              disabled={isSubmitting}
            />
          ))
        )}
      </section>

      <Separator />

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Additional models</h2>
          <span className="text-sm text-muted-foreground">
            {data.config.additional.length} available
          </span>
        </div>
        {data.config.additional.map((entry) => (
          <ModelSettingsRow
            key={entry.id}
            row={{ entry }}
            actionLabel="add"
            onAction={(model) => submit("addModel", model)}
            readOnly={readOnly}
            disabled={isSubmitting}
            capacityReached={capacityReached}
          />
        ))}
      </section>
    </div>
  );
}
