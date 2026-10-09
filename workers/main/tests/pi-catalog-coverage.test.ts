import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";

import { MODEL_CATALOG } from "../../../src/lib/model-catalog";
import { PiModelMapping } from "../src/pi-model-resolution";

const lookup = getModel as unknown as (provider: string, id: string) => unknown;
const mapping = new PiModelMapping();
const pickerModels = Object.keys(MODEL_CATALOG).filter((id) => id !== "custom");

// chiridion keeps no catalog fallbacks (chat-thread/pi-model-config.ts): every
// model it resolves must be in Pi's catalog, or its threads cannot start.
describe("Pi's catalog", () => {
  it.each(pickerModels)("has %s as chiridion resolves it", (id) => {
    const reference = mapping.resolvePiModelReference(id);
    expect(lookup(reference.provider, reference.modelId), `${reference.provider}/${reference.modelId}`).toBeTruthy();
  });

  it.each(pickerModels)("has hosted %s's OpenRouter model", (id) => {
    const reference = mapping.resolvePiModelReference(id);
    if (reference.hostedGatewayProvider !== "openrouter" || !reference.hostedModelId) return;
    const openRouterId = reference.hostedModelId.replace(/:nitro$/, "");
    expect(lookup("openrouter", openRouterId), `openrouter/${openRouterId}`).toBeTruthy();
  });
});
