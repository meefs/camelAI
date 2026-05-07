import type {
  LlmModel,
  ModelPickerModelConfig,
  OrgModelPickerConfig,
  WorkspaceModelPickerConfig,
} from "../types";
import { isLlmModel } from "./llm-provider-config";

export const MODEL_PICKER_MAX_MODELS = 10;

export interface EffectiveModelPickerConfig extends OrgModelPickerConfig {
  source: "org" | "workspace";
}

export interface ModelIdEntry {
  id: LlmModel;
}

const DEFAULT_MODEL_ORDER: readonly LlmModel[] = [
  "opus",
  "sonnet",
  "haiku",
  "gpt-5.4",
  "gpt-5.4-mini",
  "kimi-k2.6",
  "grok-4.3",
];

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
    const id = record.id;
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
  if (!isLlmModel(raw)) return null;
  return models.some((model) => model.id === raw) ? raw : null;
}

export function defaultOrgModelPickerConfig(): OrgModelPickerConfig {
  const now = Date.now();
  return {
    default_model: "sonnet",
    models: DEFAULT_MODEL_ORDER.map((id, index) => ({
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
): OrgModelPickerConfig {
  const parsed = parseMaybeJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return defaultOrgModelPickerConfig();
  }

  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.models)) {
    return defaultOrgModelPickerConfig();
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

  return args.visibleCatalog[0]?.id ?? null;
}

