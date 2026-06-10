# camelAI Platform FAQ Skill Plan

## Status

June 10, 2026 - planning draft only. Do not create the skill in this change. Every FAQ answer below has been audited against the codebase; sources are in the audit table.

## Goal

Add a short built-in Pi skill that helps the agent answer common camelAI product questions accurately. This should be a compact FAQ sheet, not a full support knowledge base: short, clear answers to the heaviest-hitting questions.

The skill must also teach the agent the Get Help flow. The question-mark button at the bottom-left of the side nav opens the Get Help dialog; submitting it starts an email thread with the support team. Whenever a question is not covered by the FAQ, or depends on account/billing state, or reports a platform bug, the agent should prompt the user to submit a Get Help request rather than guess.

Recommended skill name: `camelai-platform-faq`

Recommended path: `sandbox/skills/camelai-platform-faq/SKILL.md`

Recommended system prompt trigger: answer common camelAI platform questions about app access/passwords, workspace resources, deployed links, connections, provider keys/credits, files, and support paths.

## Codebase Audit

Facts the answers below rest on, with where to re-verify them:

| Fact | Source |
| --- | --- |
| App visibility is a single `is_public` boolean; there is no third level and no platform password feature | `workers/main/src/identity/org-do.ts` (`WorkerScript.is_public`), `src/components/pages/apps/AppSettingsDialog.tsx` |
| Private apps are gated on **org membership**, not workspace access; the dispatcher checks `isOrgMember` against the owning org and never consults workspace access levels | `workers/dispatcher/src/index.ts` (~L655-701) |
| `mcp-handler.ts` already describes private apps as "org members only" — this matches the dispatcher and needs no change | `workers/main/src/mcp-handler.ts` (`set_app_visibility`) |
| Get Help button is the `CircleHelp` icon in the sidebar footer (bottom-left); the form collects category, severity, and description, and auto-captures page URL and screen size | `src/components/sidebar/app-sidebar.tsx` (~L190), `src/components/get-help-dialog.tsx` |
| Submitting Get Help emails the support team and sends the user a confirmation with support reply-to, starting an email thread | `src/routes/api/help.ts`, `src/lib/help.ts` (`SUPPORT_EMAIL`) |
| Everything in a workspace is shared with members who have access; no resource carries a personal/public marker except app `is_public` | `src/lib/auth-do.ts` (`getWorkspaceAccess`), `migrations/0001_app_index.sql` |
| Chat (`js_exec`) and deployed apps reach connections through the same `CONNECTIONS` binding mechanism; credentials stay encrypted behind it | `workers/main/src/connections-service.ts`, `workers/main/src/cf-api-proxy.ts` |
| Channel kinds are email, Slack, and Telegram; workspace email addresses are `{handle}@WORKSPACE_EMAIL_DOMAIN` and only workspace members can start threads by email | `workers/main/src/channels.ts`, `src/lib/workspace-email.ts`, `workers/main/src/email-ingress.ts` |
| Model picker defaults are org-level with optional per-workspace override | `workers/main/src/workspace.ts` (`setModelPickerConfig`), `src/lib/model-picker-config.ts` |
| BYOK usage does not consume camelAI credits; hosted usage requires credits; plan/credit balance lives at Settings → Organization → Billing | `src/lib/billing-plans.ts`, `src/routes/_app.settings.organization.billing.tsx` |
| Generated report/download links are workspace-scoped routes that require sign-in and workspace access | `src/routes/api/workspaces.$id.outputs.$.ts`, `src/lib/workspace-r2-paths.ts` |
| No docs site or help-center link exists in the product; Get Help is the only support surface | searched `src/` for help/support/docs surfaces |

Two findings to keep in mind when editing answers:

- The visibility-toggle permission story is inconsistent in code: the settings dialog restricts the toggle to org admins, but the apps page action and the `set_app_visibility` MCP tool do not enforce a role. The FAQ stays vague on *who* can toggle until that is reconciled.
- "Proxy apps" are not a first-class platform concept (no schema or settings surface), so the FAQ no longer presents them as one.

## Proposed Skill Sheet

```markdown
---
name: camelai-platform-faq
description: Answer common camelAI platform questions about app access/passwords, workspace resources, deployed links, connections, provider keys/credits, files, and support paths. Use when the user asks how camelAI itself works rather than asking you to build, debug, or analyze something.
---

# camelAI Platform FAQ

Give short, direct answers from this sheet. Do not guess beyond it.

## Getting help

The Get Help button is the question-mark icon at the bottom-left of the side nav. Submitting the form starts an email thread with the camelAI support team; the user gets a confirmation email and can reply to continue the conversation. The current page URL is captured automatically, so the user only needs to describe what they were doing, what happened, and what they expected.

Prompt the user to submit a Get Help request when:

- The question is not answered in this FAQ.
- The answer depends on their account, plan, or billing state.
- They are reporting a bug or something looks broken on camelAI's side.

## FAQs

### What is the difference between a public, private, and password-protected app?

A public app can be viewed by anyone on the internet with the app URL.

A private app can only be viewed by signed-in members of your organization.

Password protection is not a camelAI setting. If you want a password gate, I can build one into your app — but the URL is still public, so for sensitive data make the app private instead.

### What is a workspace?

A workspace is a shared space inside your organization that holds chats, files, projects, connections, and deployed apps. Everything in a workspace is shared: any member with access to the workspace can use everything in it.

### What is the difference between a chat, a project, and an app?

A chat is a conversation with the agent. A project is where code is written and run. An app is the published result with its own URL. Changes to project files do not appear in the live app until it is deployed again.

### Where do my files live?

Files you upload in chat, files saved in the workspace, and files inside a project are separate places; I can copy files between them. Generated reports and downloads are served through workspace links.

### Why doesn't a report or download link work for someone else?

Report and download links are workspace-scoped: they require signing in with access to the workspace. To share something with people outside the workspace, deploy it as an app or send them the file itself.

### Can camelAI connect to external services?

Yes. Connections cover databases (Postgres, MySQL, Snowflake, MongoDB, and more), SaaS APIs (Stripe, Notion, GitHub, Slack, and more), and custom APIs. Credentials are stored encrypted and are never exposed in chat or app code — the agent and your apps call connections through secure bindings, so never paste API keys into app code.

### Are connections in chat the same as in deployed apps?

Yes. The agent in chat and your deployed apps use the same workspace connections through the same binding mechanism.

### Can I use camelAI by email, Slack, or Telegram?

Yes, all three. Each workspace has its own email address; emailing it starts a chat in that workspace, and only workspace members can use it. Slack and Telegram are set up per workspace through integrations.

### Can I set defaults for everyone in a workspace?

Model defaults can be set for the organization in settings, and a workspace can override them. For working preferences — "always use this database," "format reports this way" — ask me to save them in a workspace file so they persist across chats.

### How do hosted model credits and bring-your-own-key differ?

camelAI-hosted models consume your organization's camelAI credits. If you connect your own provider key (OpenAI, Anthropic, OpenRouter, and others), usage bills to that provider instead and does not consume camelAI credits. Your plan and credit balance are in Settings → Organization → Billing.

### Why is my API key or model provider failing?

Check whose limit it is. If the error names a provider (OpenAI, Anthropic, OpenRouter, Bedrock), the problem is on the provider side — an invalid key, a rate limit, or exhausted provider credits — and is fixed in that provider's dashboard. If camelAI says you are out of credits, check Settings → Organization → Billing. If neither fits, submit a Get Help request.

### What if I am not sure about a camelAI product answer?

Say what you know, name the uncertainty, and prompt the user to submit a Get Help request. For app-specific technical failures, inspect the workspace/app state or use the relevant troubleshooting skill before answering.
```

## Implementation Notes

- Add `sandbox/skills/camelai-platform-faq/SKILL.md` with the proposed content.
- Update `workers/main/src/pi-system-prompt.ts` so `SKILL_TRIGGERS` includes `camelai-platform-faq`.
- Regenerate `docs/pi-system-prompt.md` with `bun run generate:pi-system-prompt-doc` after updating the runtime prompt source.
- Confirm `PI_SKILL_NAMES` picks up the new skill through `workers/main/src/pi-skills-bundle.ts`.
- `workers/main/src/mcp-handler.ts` already states "org members only" for private apps; it matches the dispatcher and the FAQ. Do not rewrite it to a workspace-member rule.
- Do not fold the internal admin analytics recipe from `docs/user-questions-audit.md` into this customer-facing FAQ skill.

## Acceptance Criteria

- A user asking about public vs private apps gets the org-member answer for private apps and the "password gates are app code, not a platform setting" distinction.
- A user asking about a broken report/download link gets the workspace-scoped explanation and a concrete next step.
- A user asking about API-key failures gets the provider-side vs camelAI-hosted diagnostic.
- A question outside the FAQ produces a prompt to use the Get Help button (bottom-left of the side nav), not a guessed answer.
- The skill stays short enough for on-demand reading, and the system prompt lists it with a clear trigger.
