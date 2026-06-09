# camelAI Platform FAQ Skill Plan

## Status

June 8, 2026 - planning draft only. Do not create the skill in this change.

## Goal

Add a short built-in Pi skill that helps the agent answer common camelAI product questions accurately. This should be a compact FAQ sheet, not a full support knowledge base. If the user needs current plan details, account-specific help, or wants to report a problem, the agent should direct them to the camelAI docs or the in-app Get Help flow.

This plan incorporates the question patterns from `docs/user-questions-audit.md`: users are not only asking generic platform questions; they are asking about public/protected app access, connections, broken links, workspace defaults, and provider/API-key failures.

Recommended skill name: `camelai-platform-faq`

Recommended path: `sandbox/skills/camelai-platform-faq/SKILL.md`

Recommended system prompt trigger: answer common camelAI platform questions about app access/passwords, workspace resources, deployed links, connections, provider keys/credits, files, and support paths.

## Audit Takeaways

- The top FAQ should be "public vs private vs password-protected," not only "public vs private." Users are trying to understand whether a public app with an app-level password gate is protected.
- Connections need clearer language around chat/runtime access versus deployed app access. Users ask whether `js_exec` connections are the same as connections inside Workers/apps.
- Broken generated report links and app URLs are a real support category. The skill should tell the agent how to explain workspace-scoped links without pretending all app URLs behave the same.
- Workspace-wide defaults are a recurring mental-model gap. The skill should distinguish current settings/model defaults from broader persistent instructions that may need product support or explicit workspace docs.
- Provider/model questions are usually diagnostics, not pricing questions: is a key configured, does it have credits/budget, is the provider rate-limiting, or is camelAI out of hosted credits?
- Admin analytics and system-prompt workflow questions are valuable internally, but they should not bloat the customer-facing FAQ skill. Keep those in separate internal docs or recipes.

## High-Level FAQ Buckets

1. Public app access, passwords, and visibility
   - Public, private, and app-level password protection.
   - Who can access workspace-private apps.
   - What to do before exposing sensitive data.

2. Workspaces, chats, projects, and deployed apps
   - Difference between a workspace, chat thread, project, and deployed app.
   - Where source files live versus where published apps live.
   - What it means to redeploy or publish an app.

3. Connections and integrations
   - Connections in chat/`js_exec` versus deployed app connections.
   - Credential handling.
   - Google Sheets, Apps Script, Slack, email, and custom APIs.

4. Deployed links, report downloads, and routing
   - `*.camelai.app` app URLs.
   - Workspace-scoped file/download links.
   - Custom domains, proxy apps, and default app routing.

5. Workspace defaults and persistent instructions
   - Workspace-level model settings.
   - Persistent data-source or formatting preferences.
   - What to save in docs/app config versus what needs product support.

6. Files and outputs
   - Uploaded files, workspace files, project VM files, and downloadable outputs.
   - When to use preview versus download links.

7. Billing, credits, provider keys, and model access
   - Hosted camelAI credits versus bring-your-own-key providers.
   - Provider-side rate limits and missing provider credits/budget.
   - Plan details should point to docs because pricing and limits can change.

8. Help and troubleshooting
   - When to use docs.
   - When to use the in-app Get Help flow.
   - What details to include in a support request.

## Proposed Skill Sheet

```markdown
---
name: camelai-platform-faq
description: Answer common camelAI platform questions about app access/passwords, workspace resources, deployed links, connections, provider keys/credits, files, and support paths. Use when the user asks how camelAI itself works rather than asking you to build, debug, or analyze something.
---

# camelAI Platform FAQ

Use this skill for concise product answers. If a question depends on current pricing, account state, policy, or support follow-up, direct the user to the camelAI docs or the in-app Get Help flow.

## FAQs

### What is the difference between a public, private, and password-protected app?

A public app can be viewed by anyone on the internet with the app URL.

A private app is not "only visible to you." It can be accessed by members who have access to the current workspace. That means teammates with access to the workspace can access the private app.

Password protection is separate from camelAI app visibility. If an app has its own password gate, the public URL may still be reachable on the internet, but the app can require a password before showing protected content. Session duration, failed-attempt lockout, notifications, and password storage depend on how that app was implemented.

For sensitive data, prefer private visibility or a carefully reviewed authentication flow. Do not claim that an app-level password gate changes the platform visibility from public to private.

Admins can change app visibility from the app settings surface, or through agent tools when available.

### What is a workspace?

A workspace is the shared area where chats, files, projects, connections, automations, and deployed apps are organized. Treat workspace resources as available to members with access to that workspace unless the product UI says a resource is personal or public.

### What is the difference between a chat, project, and app?

A chat is the conversation with the agent. A project is the compute and code area where software is built and run. A deployed app is the published result with a URL. Editing project files does not always mean the published app has changed; the app may need to be redeployed or published.

### Why does a report or download link say "Workspace not found"?

Generated file links are usually scoped to a workspace. A "Workspace not found" error can mean the link is stale, malformed, copied from the wrong workspace, or using an old URL pattern. Ask the agent to regenerate or validate the link in the current workspace. If the link came from a deployed app or external share, include the URL and error text in Get Help.

### How are deployed app URLs, custom domains, and proxy apps different?

A deployed app has a camelAI app URL. A custom domain is an optional hostname mapped to a specific deployed app. A proxy app is a separate deployed Worker/app that forwards or modifies requests before they reach another app. These are different routing layers, so changing one does not automatically change the others.

### Where do my files live?

camelAI has multiple file surfaces. Workspace files are durable files in the workspace. Project files live in a project's VM checkout. User uploads are files the user attached in chat. Generated outputs can be linked for download or shown in preview when supported.

### Can camelAI connect to external services?

Yes, through Connections and channel integrations. Credentials are hidden behind connection bindings and should not be exposed in chat, files, or app code. If the user asks to connect a service and a setup flow is available, guide them through that flow.

### Are connections in chat the same as connections in deployed apps?

They are related but not always identical. In chat or `js_exec`, the agent can use workspace connection bindings directly. Deployed apps need the appropriate app/runtime binding or generated code path to access a connection. Do not paste API keys into app code; use camelAI connection bindings when available.

If the user asks whether camelAI can access a service, check whether a connection exists, whether auth is complete, which methods are available, and whether there is a sample call.

### Can I use camelAI by email, Slack, or Telegram?

Only when the relevant channel is configured for the workspace. Workspace email messages start threads in that workspace, and only members of the workspace can send to that address. Slack and Telegram behavior depends on the workspace's configured integrations.

### Can I set defaults for everyone in a workspace?

Some workspace or organization settings, such as model picker defaults, can be configured in settings. Broader preferences, such as "use this database by default" or "format reports this way," should be saved in a durable workspace file, project docs, or app configuration if no first-class setting exists. If the user wants defaults to apply across all users and future chats, explain the current limitation and suggest Get Help or product feedback.

### How do hosted model credits and BYOK differ?

Hosted camelAI models use camelAI credits according to the organization's plan and credit balance. Bring-your-own-key providers use the user's connected provider credentials instead of hosted camelAI credits. For exact plan limits, pricing, trials, or credit rules, point the user to the camelAI docs.

### Why is my API key or model provider failing?

First distinguish camelAI hosted credits from provider-side issues. A BYOK provider can fail because the key is missing, invalid, rate-limited, out of provider credits/budget, or lacks access to a requested model. A hosted camelAI request can fail because the organization has no hosted credits or billing access. If the error names OpenAI, Anthropic, OpenRouter, or Bedrock, do not assume camelAI controls the limit.

### How do I get help or report a bug?

Use the in-app Get Help flow from the sidebar. For faster support, include what you were trying to do, the page URL, what happened, what you expected, and any error text or screenshots. For general product or plan questions, check the camelAI docs first.

### What if I am not sure about a camelAI product answer?

Do not guess. Say what you know, name the uncertainty, and direct the user to the camelAI docs or Get Help. For app-specific technical failures, inspect the available workspace/app state or use the relevant troubleshooting skill before answering.
```

## Implementation Notes

- Add `sandbox/skills/camelai-platform-faq/SKILL.md` with the proposed short FAQ content.
- Update `workers/main/src/pi-system-prompt.ts` so `SKILL_TRIGGERS` includes `camelai-platform-faq`.
- Regenerate or refresh `docs/pi-system-prompt.md` with `bun run generate:pi-system-prompt-doc` after updating the runtime prompt source.
- Confirm `PI_SKILL_NAMES` picks up the new skill through `workers/main/src/pi-skills-bundle.ts`.
- Check for stale app-visibility wording outside the new skill. In particular, `workers/main/src/mcp-handler.ts` currently describes private apps as requiring authentication or org-member access; align it with the workspace-member rule to avoid contradicting the FAQ.
- Do not fold the internal admin analytics recipe from `docs/user-questions-audit.md` into this customer-facing FAQ skill. If needed, create a separate internal admin analytics note covering `searchThreads`, `getThreadMessages`, user-message filtering, and question classification.

## Acceptance Criteria

- A user asking "what is the difference between a public and private app?" gets the workspace-member answer for private apps.
- A user asking whether a public app can be password protected gets the distinction between platform visibility and app-level password gates.
- A user asking about connections gets the chat/`js_exec` versus deployed-app distinction.
- A user asking about a broken report/download link gets the workspace-scoped link explanation and a concrete next step.
- A user asking about OpenRouter/OpenAI/API-key failures gets a provider-side versus camelAI-hosted diagnostic answer.
- The skill remains short enough for on-demand reading and does not duplicate full docs.
- The system prompt lists the new skill with a clear trigger.
- The skill points users to camelAI docs or Get Help for current, account-specific, or unresolved questions.
