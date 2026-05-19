import type {
  LlmModel,
  LlmProvider,
  ModelPickerModelConfig,
  OrgModelPickerConfig,
  WorkspaceModelPickerConfig,
} from "../types";
import { isLlmModel, replaceLegacyLlmModel } from "./llm-provider-config";

export const MODEL_PICKER_MAX_MODELS = 10;

export interface EffectiveModelPickerConfig extends OrgModelPickerConfig {
  source: "org" | "workspace";
}

export interface ModelIdEntry {
  id: LlmModel;
}

const HOSTED_OR_OPENROUTER_DEFAULT_MODEL_ORDER: readonly LlmModel[] = [
  "opus-4.7",
  "sonnet",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "kimi-k2.6",
  "grok-4.3",
];

const OPENAI_DEFAULT_MODEL_ORDER: readonly LlmModel[] = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
];

const CLAUDE_DEFAULT_MODEL_ORDER: readonly LlmModel[] = [
  "opus-4.7",
  "opus",
  "sonnet",
  "haiku",
];

function defaultModelOrderForProvider(
  orgProvider?: LlmProvider | string | null,
): readonly LlmModel[] {
  switch (orgProvider) {
    case "openai":
      return OPENAI_DEFAULT_MODEL_ORDER;
    case "anthropic":
    case "bedrock":
      return CLAUDE_DEFAULT_MODEL_ORDER;
    case "openrouter":
    default:
      return HOSTED_OR_OPENROUTER_DEFAULT_MODEL_ORDER;
  }
}

function parseMaybeJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeModelRows(raw: unknown): ModelPickerModelConfig[] {
  if (!Array.isArray(raw)) return [];

  const now = Date.now();
  const seen = new Set<LlmModel>();
  const rows: ModelPickerModelConfig[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = replaceLegacyLlmModel(record.id);
    if (!isLlmModel(id) || seen.has(id)) continue;
    seen.add(id);
    const addedAt =
      typeof record.added_at === "number" && Number.isFinite(record.added_at)
        ? record.added_at
        : now;
    rows.push({ id, added_at: addedAt });
    if (rows.length >= MODEL_PICKER_MAX_MODELS) break;
  }

  return rows;
}

function normalizeDefaultModel(
  raw: unknown,
  models: readonly ModelPickerModelConfig[],
): LlmModel | null {
  const normalized = replaceLegacyLlmModel(raw);
  if (!isLlmModel(normalized)) return null;
  return models.some((model) => model.id === normalized) ? normalized : null;
}

export function defaultOrgModelPickerConfig(
  orgProvider?: LlmProvider | string | null,
): OrgModelPickerConfig {
  const now = Date.now();
  const defaultOrder = defaultModelOrderForProvider(orgProvider);
  return {
    default_model: null,
    models: defaultOrder.map((id, index) => ({
      id,
      added_at: now - index,
    })),
  };
}

export function defaultWorkspaceModelPickerConfig(): WorkspaceModelPickerConfig {
  return {
    use_org_defaults: true,
    models: [],
    default_model: null,
  };
}

export function parseOrgModelPickerConfig(
  raw: unknown,
  orgProvider?: LlmProvider | string | null,
): OrgModelPickerConfig {
  const parsed = parseMaybeJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return defaultOrgModelPickerConfig(orgProvider);
  }

  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.models)) {
    return defaultOrgModelPickerConfig(orgProvider);
  }

  const models = normalizeModelRows(record.models);
  return {
    models,
    default_model: normalizeDefaultModel(record.default_model, models),
  };
}

export function parseWorkspaceModelPickerConfig(
  raw: unknown,
): WorkspaceModelPickerConfig {
  const parsed = parseMaybeJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return defaultWorkspaceModelPickerConfig();
  }

  const record = parsed as Record<string, unknown>;
  const models = normalizeModelRows(record.models);
  return {
    use_org_defaults: record.use_org_defaults !== false,
    models,
    default_model: normalizeDefaultModel(record.default_model, models),
  };
}

export function resolveEffectivePickerConfig(
  org: OrgModelPickerConfig,
  workspace: WorkspaceModelPickerConfig | null | undefined,
): EffectiveModelPickerConfig {
  if (!workspace || workspace.use_org_defaults) {
    return { ...org, source: "org" };
  }

  return {
    models: workspace.models,
    default_model: workspace.default_model,
    source: "workspace",
  };
}

export function hasModelPickerDefault(
  config: Pick<OrgModelPickerConfig, "default_model">,
): boolean {
  return config.default_model !== null;
}

export function resolveDefaultModelForChat(args: {
  effectiveDefaultModel: LlmModel | null;
  visibleCatalog: ReadonlyArray<ModelIdEntry>;
  recentModel?: LlmModel | null;
  fallbackModel?: LlmModel | null;
}): LlmModel | null {
  const visibleIds = new Set(args.visibleCatalog.map((entry) => entry.id));

  if (
    args.effectiveDefaultModel &&
    visibleIds.has(args.effectiveDefaultModel)
  ) {
    return args.effectiveDefaultModel;
  }

  if (args.recentModel && visibleIds.has(args.recentModel)) {
    return args.recentModel;
  }

  if (args.fallbackModel && visibleIds.has(args.fallbackModel)) {
    return args.fallbackModel;
  }

  return args.visibleCatalog[0]?.id ?? null;
}
