// Shim: @cloudflare/ai-chat imports { agentContext } from "agents/internal_context",
// but agents@0.6.0 renamed the export to __DO_NOT_USE_WILL_BREAK__agentContext
// and removed the subpath from its exports map. This re-exports under the old name
// so the build succeeds with Rolldown (Vite 8) strict exports resolution.
// Use a direct relative path to bypass the package exports map.
// @ts-expect-error internal export not in public types
export { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "../node_modules/agents/dist/internal_context.js";
