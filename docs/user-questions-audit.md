Date: June 8th, 2026

# Platform Question Audit — What Users Are Asking

I re-reviewed the recent 250-thread sample with the goal of extracting *actual questions*, not just keyword categories. The useful finding is that the naive keyword pass over-matches heavily, but after removing scheduler/context noise and focusing on platform-specific language there are a handful of recurring question types.

## Executive recommendation

Build the audit as a two-stage pipeline:

1. **Broad retrieval**: pull `role=user` messages from `@admin_api_mcp.getThreadMessages`, strip system/context boilerplate, and use broad keywords to get candidates.
2. **Question extraction/classification**: use an LLM or stricter rules to convert each candidate into a canonical question and reject customer-domain false positives.

The product/support value is in the second stage: “what question is being asked?” not “which keywords matched?”

In this 250-thread sample, the highest-signal platform questions cluster around public app access/passwords, connections/integrations, workspace defaults, deployed app/link errors, provider/model access, and internal admin/user-message analytics.

## Questions users are asking

### 1. Public links, passwords, and app access

Representative questions:

- Can I password-protect links that are public?
- If I add a password gate, does a public link become protected?
- Can a public app require a password every time someone opens it?
- Can it lock/block after three failed password attempts and notify me?
- Can you add/change the password on this deployed app?
- Can you check whether sensitive data in my workspace/app is publicly visible?

Examples from the sample:

- SECLOCK: “Can I password protect links that are ‘public’?”
- SECLOCK: “so, essentially, with the password gate, a public link does become protected?”
- SECLOCK: “I would like a password to be entered each time someone wants to open it. And I want it to lock or block after three failed attempts. Maybe let me know, too.”
- Salix River & Wetland Services: “it is available in my workspace not sure if it's publicly available as sensitive data. if I provide you the link could you check if data is visible?”

Recommendation:

- Treat this as a real product/docs gap. Users do not have a clear mental model for “public,” “protected,” and “workspace-private.”
- Add a help article or UI copy: “Public app visibility vs password-protected app access.”
- Consider first-class password protection controls: password, session duration, failed-attempt lockout, and optional owner notification.

### 2. Connections and integrations

Representative questions:

- How do external connections work from deployed Workers/apps?
- Are Worker connections the same as connections available in `js_exec`?
- Do I need to configure the connections binding manually, or is it already set up?
- Can you create a custom connection?
- What ways can camelAI connect to Google Sheets?
- Can you connect to this Google Apps Script / Google Sheet using an existing connection?
- Can you send a Slack message through the Slack integration?
- Can you see messages/emails from a connected channel?

Examples from the sample:

- m's Workspace: “what does [the developing software skill] say about calling external connections?”
- m's Workspace: “Is this mostly the same as using the connections from js_exec?”
- m's Workspace: “Did you have to set up the connections binding in the worker or was it already set up for you?”
- Test Org 1: “Please give me all the ways that you can connect to Google Sheets…”
- Test Org 1: “Can you create a custom connection out of it?”
- camelAI Team: “@camelai can you send a message in our slack?”

Recommendation:

- This should become a documented platform concept: **Connections in chat vs connections in deployed apps**.
- Users need examples for Google Sheets, Apps Script, Slack, email, and custom API connections.
- Add a “Can camelAI access this?” diagnostic pattern: connection exists, auth status, available methods, sample call.

### 3. Admin analytics and “user sent messages”

Representative questions:

- Can we access user-sent messages via the Admin API or MCP?
- What is the difference between thread messages and user-sent messages?
- Can we analyze a specific customer/org’s user-sent messages to understand usage and re-engagement?
- What are users most frequently asking in a given org?
- When did a specific user last send a message?

Examples from the sample:

- camelAI Team: “Can you access user sent messages in either our @camelai_admin_api or our @admin_api_mcp?”
- camelAI Team: “there's a difference between thread messages and user sent messages. User sent messages is the true count of how many messages a user sent…”
- camelAI Team: “I want to know in general what are the most frequently asked questions, I want to know how and why most people are using us.”
- camelAI Team: “I’d be interested in understanding the last time Emily sent a message in Camel AI…”

Recommendation:

- Add an internal analytics recipe: `searchThreads` → `getThreadMessages` → filter `role=user` → strip context → classify user intent.
- In dashboards/reports, label metrics explicitly as “user messages” vs “all thread messages.”
- Consider a first-class Admin API endpoint for user-message search/classification to avoid thread-by-thread scraping.

### 4. Deployed app links and workspace/report download errors

Representative questions:

- Why do I get `{"error":"Workspace not found"}` when clicking/downloading a report link?
- Can you fix or check this camelAI app URL?
- Can you make this app URL/default deployment point to a different deployed app/proxy?
- Can a proxy Worker sit in front of a camelAI app and modify/forward requests?

Examples from the sample:

- Egill Masson: “I get {"error":"Workspace not found"} when I try to download the report.”
- Egill Masson: “Get {"error":"Workspace not found"} when I click link.”
- Goyim: “still error on https://geometry-ar-btatu5.camelai.app/ar-xray.html…”
- Goyim: “if i give you my cloudflare API token can you edit or modified a proxy worker — it sits in front of the camelai app and forwards requests?”
- Goyim: “let's make this app default https://geometry-ar-proxy-btatu5.camelai.app”

Recommendation:

- Link generation/download failures are a concrete support category. Add automated link validation for generated report/download links.
- Document app URL lifecycle: deployed app URL, custom/default app, proxy app, and workspace-scoped file URLs.
- Consider surfacing app routing/default app controls more clearly.

### 5. Workspace defaults and persistent instructions

Representative questions:

- How can I set defaults for all users in a workspace?
- Can a database or data source be the default unless users request otherwise?
- Can calculation rules or formatting preferences be made persistent workspace defaults?

Example from the sample:

- BrandRank.ai: “How do I get you, for all users in this workspace, to have the following as defaults? 1 - that database is the primary data source unless user specifically requests otherwise…”

Recommendation:

- This is a strong product opportunity: workspace-level instructions/preferences.
- Users want persistent defaults that apply across users, threads, and analyses.
- If this already exists, it needs clearer UX/docs; if not, it is worth considering.

### 6. Model/provider access and API key issues

Representative questions:

- Can you run this using the OpenRouter integration?
- Why is my OpenAI API key rate limited, and is that controlled by camelAI?
- Can you check whether someone’s OpenRouter key lacks credits or budget?
- What is the connection MCP server returning for provider/key availability?

Examples from the sample:

- missirina 383: “can you run it with open router integration?”
- missirina 383: “Your OpenAI API key is rate limited… This limit is controlled by OpenAI, not camelAI…”
- camelAI Team: “can you get her openrouter api key and see if it doesn't have enough credits or budget?”
- camelAI Team: “what is the connection mcp server returning?”

Recommendation:

- Add a provider diagnostic flow: provider configured? key present? key valid? provider says rate-limited? budget exhausted?
- In user-facing errors, clearly distinguish camelAI limits from provider-side limits.

### 7. System behavior and file/app creation policy

Representative questions:

- Should camelAI allow creation of small local HTML files instead of always deploying a full app?
- What is confusing in the development/scaffolding instructions for AI agents?
- Did the assistant use the Pi agent/coding agent to build this app?

Examples from the sample:

- camelAI Team: “we tell you not to make local html files but I want you to do it anyway… see if we should remove this code from your system instructions…”
- camelAI Team: “tell me what's confusing about this… I need to make this more friendly for AIs like yourself.”
- Goyim: “did you using Pi agent for coding this app or did camel ai using Pi agent?”

Recommendation:

- Internal docs/system-prompt work should be tracked separately from customer-facing platform questions.
- The local-file vs deployed-app question is a real UX/workflow issue: lightweight artifacts may be useful for simple outputs.

## Proposed taxonomy for future audits

Use these top-level buckets:

1. Public app access, passwords, and visibility
2. Connections and integrations
3. Admin/user-message analytics
4. Deployed app links, report downloads, and routing
5. Workspace defaults and persistent instructions
6. Model/provider access and API key diagnostics
7. System behavior / agent workflow / artifact policy
8. Other platform support

## Suggested next step

Run this over a larger window, but keep the LLM extraction stage. The raw keyword categories are useful for recall, but they do not answer the product question. The final output should be a weekly digest of canonical questions, counts, representative quotes, affected orgs, and recommended product/support actions.
