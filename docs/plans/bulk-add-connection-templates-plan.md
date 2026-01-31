# Bulk Add Connection Templates Plan

## Overview

Add 8 new API-key-based connection templates to the integration registry. All templates use the **env-vars-only** pattern: store credentials/config, expose them as `INT_*` environment variables in the workspace, and let the agent/application code call vendor APIs directly. No `proxyConfig` on any new template.

These services already have logos in `public/logos/` and icon entries in `integration-icons.tsx`. The work is mostly additive: define each template in the registry and add env var mappings. The only UI change is adding optional `description` help text rendering to `AddConnectionDialog.tsx` and `EditConnectionDialog.tsx` (a small, reusable enhancement). No new pages, routes, or components are needed — the existing connections page dynamically renders templates from the registry.

---

## Research Summary: API Key Eligibility

Each service on the wishlist was evaluated for simple API key authentication support.

### Approved for This Plan (API Key Works)

| Service | Auth Model | User Provides |
|---------|-----------|---------------|
| **Supabase** | Bearer + `apikey` header | API Key (anon or service role) + Project URL |
| **Databricks** | Bearer token | Personal Access Token + Workspace URL |
| **Sentry** | Bearer token | Auth Token (org-level) |
| **OpenRouter** | Bearer token | API Key |
| **Mailchimp** | HTTP Basic (any:`apikey`) | API Key + Data Center |
| **PostHog** | Bearer token | Personal API Key + Host + Project ID |
| **Mixpanel** | HTTP Basic (Service Account) | SA Username + SA Secret + Project ID + Region |
| **Typeform** | Bearer token | Personal Access Token |

### Skipped (Not Simple API Key)

| Service | Reason |
|---------|--------|
| **Snowflake** | Requires RSA key pair + JWT signing. No simple token auth. |
| **Salesforce** | OAuth2 only. Already in registry as OAuth. |
| **X / Twitter** | Bearer token is read-only (public data only). Requires paid tier ($100/mo+). Obtaining the bearer token requires creating a Twitter App first -- not a simple "paste your key" flow. |

### Already in Registry (Audit and Fixes in This Plan)

BigQuery, GitHub, Linear, OpenAI, Anthropic, SendGrid, Twilio, Stripe, Airtable, HubSpot, Notion (OAuth), Slack (OAuth)

These templates already exist but need `proxyConfig` removed (global decision). Some also have bugs — see the **Audit: Existing Templates** section for full details.

---

## Global Design Decision: No Proxy

All new templates omit `proxyConfig`. The pattern for every template in this plan is:

```
┌──────────────────────────────────────────────────────────────┐
│  User fills form  ──►  Credentials encrypted & stored        │
│                        in WorkspaceDO                        │
│                              │                               │
│                              ▼                               │
│                   Env vars injected into container            │
│                                                              │
│                   INT_SUPABASE_MYPROJECT_API_KEY              │
│                   INT_SUPABASE_MYPROJECT_PROJECT_URL          │
│                              │                               │
│                              ▼                               │
│                   Agent / app code calls vendor API           │
│                   directly (via SDK or fetch)                 │
└──────────────────────────────────────────────────────────────┘
```

No Chiridion proxy layer sits between the container and the vendor API.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    INTEGRATION REGISTRY                         │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ supabase │ │databricks│ │  sentry  │ │openrouter│  NEW      │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │mailchimp │ │ posthog  │ │ mixpanel │ │ typeform │  NEW      │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │  stripe  │ │  github  │ │  openai  │ │   ...    │  EXISTING │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
└─────────────────────────────────────────────────────────────────┘
        │                                        │
        ▼                                        ▼
┌───────────────────┐                ┌───────────────────────┐
│  integration-     │                │  integration-env.ts   │
│  icons.tsx        │                │  (env var mapping)    │
│  (logos already   │                │                       │
│   registered)     │                │  INT_SUPABASE_X_*     │
│                   │                │  INT_POSTHOG_X_*      │
│  supabase ✓       │                │  INT_MAILCHIMP_X_*    │
│  databricks ✓     │                │  ...                  │
│  sentry ✓         │                │                       │
│  openrouter ✓     │                └───────────────────────┘
│  mailchimp ✓      │
│  posthog ✓        │
│  mixpanel ✓       │
│  typeform ✓       │
└───────────────────┘
```

The connections UI dynamically renders all templates from the registry. The only UI change is rendering the new optional `description` field as help text under inputs (see Phase 1).

---

## New Template Definitions

### 1. Supabase

- **Type:** `supabase`
- **Category:** `databases`
- **Description:** "Connect to a Supabase project"

```
┌─────────────────────────────────────────────────────────┐
│  Add Supabase Connection                                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Connection Name  [________________________]            │
│                                                         │
│  ── Config ──                                           │
│                                                         │
│  Project URL *    [https://xyz.supabase.co ]            │
│                                                         │
│  Key Type *       [ Anon Key ▼ ]                        │
│                   ┌───────────────────────────────┐     │
│                   │ ○ Anon Key                    │     │
│                   │   Respects Row Level Security  │     │
│                   │ ○ Service Role Key             │     │
│                   │   ⚠ Bypasses RLS — full access │     │
│                   └───────────────────────────────┘     │
│                                                         │
│  ── Credentials ──                                      │
│                                                         │
│  API Key *        [••••••••••••••••••••••••••••••]      │
│                                                         │
│                            [Cancel]  [Connect]          │
└─────────────────────────────────────────────────────────┘
```

**Config fields:**

| Field | Label | Type | Required | Default | Options / Placeholder |
|-------|-------|------|----------|---------|----------------------|
| `project_url` | Project URL | string | yes | — | `https://your-project.supabase.co` |
| `key_type` | Key Type | select | yes | `anon` | `anon` → "Anon Key (respects RLS)", `service_role` → "Service Role Key (bypasses RLS)" |

**Credential fields:**

| Field | Label | Type | Required | Placeholder |
|-------|-------|------|----------|-------------|
| `api_key` | API Key | password | yes | `eyJ...` |

**No `proxyConfig`.** The agent uses env vars directly (typically via `@supabase/supabase-js`).

**Env var suffixes:** `API_KEY`, `PROJECT_URL`, `KEY_TYPE`

**Env var mapping logic:**
```typescript
case 'supabase':
  if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
  if (str(config.project_url)) set('PROJECT_URL', str(config.project_url)!);
  if (str(config.key_type)) set('KEY_TYPE', str(config.key_type)!);
  break;
```

---

### 2. Databricks

- **Type:** `databricks`
- **Category:** `databases`
- **Description:** "Connect to a Databricks workspace"

**Config fields:**

| Field | Label | Type | Required | Placeholder |
|-------|-------|------|----------|-------------|
| `workspace_url` | Workspace URL | string | yes | `https://dbc-abc123.cloud.databricks.com` |

**Credential fields:**

| Field | Label | Type | Required | Placeholder |
|-------|-------|------|----------|-------------|
| `api_key` | Personal Access Token | password | yes | `dapi...` |

**No `proxyConfig`.** Workspace URL varies per deployment.

**Env var suffixes:** `API_KEY`, `WORKSPACE_URL`

**Env var mapping logic:**
```typescript
case 'databricks':
  if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
  if (str(config.workspace_url)) set('WORKSPACE_URL', str(config.workspace_url)!);
  break;
```

---

### 3. Sentry

- **Type:** `sentry`
- **Category:** `saas`
- **Description:** "Error monitoring with Sentry"

```
┌─────────────────────────────────────────────────────────┐
│  Add Sentry Connection                                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Connection Name  [________________________]            │
│                                                         │
│  ── Config ──                                           │
│                                                         │
│  Organization     [my-org                  ]            │
│  Slug                                                   │
│                                                         │
│  ── Credentials ──                                      │
│                                                         │
│  Auth Token *     [••••••••••••••••••••••••]            │
│                                                         │
│  ℹ Create an Organization Auth Token at                 │
│  Settings → Auth Tokens. Required scopes:               │
│  project:read, org:read, event:read.                    │
│  Add project:write and team:read for full access.       │
│                                                         │
│                            [Cancel]  [Connect]          │
└─────────────────────────────────────────────────────────┘
```

**Config fields:**

| Field | Label | Type | Required | Placeholder |
|-------|-------|------|----------|-------------|
| `organization` | Organization Slug | string | no | `my-org` |

**Credential fields:**

| Field | Label | Type | Required | Placeholder |
|-------|-------|------|----------|-------------|
| `api_key` | Auth Token | password | yes | `sntrys_...` |

**No `proxyConfig`.** Base URL is always `https://sentry.io/api/0/`.

**Env var suffixes:** `API_KEY`, `ORGANIZATION`

**Env var mapping logic:**
```typescript
case 'sentry':
  if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
  if (str(config.organization)) set('ORGANIZATION', str(config.organization)!);
  break;
```

**Note:** The scope hint text uses the `description` field on `CredentialField`, added in Phase 1. See Phase 1 for the interface change and UI rendering details.

---

### 4. OpenRouter

- **Type:** `openrouter`
- **Category:** `ai_services`
- **Description:** "Access LLMs via OpenRouter"

**Config fields:** None

**Credential fields:**

| Field | Label | Type | Required | Placeholder |
|-------|-------|------|----------|-------------|
| `api_key` | API Key | password | yes | `sk-or-...` |

**No `proxyConfig`.** Base URL for agent use is `https://openrouter.ai/api/v1` (OpenAI-compatible).

**Env var suffixes:** `API_KEY` (default fallback handles this)

**Important:** The base URL must be `https://openrouter.ai/api/v1` (with `/v1`), not `https://openrouter.ai/api`. The `/v1` path is required for the OpenAI-compatible chat completions endpoint. Since we're using env-vars-only, this is documentation for the agent, not a code concern. However, if we expose a `BASE_URL` env var for convenience, it should be `https://openrouter.ai/api/v1`.

**Env var mapping logic:**
```typescript
// Falls through to default case: set('API_KEY', ...)
// No custom case needed
```

---

### 5. Mailchimp

- **Type:** `mailchimp`
- **Category:** `saas`
- **Description:** "Email marketing with Mailchimp"

```
┌─────────────────────────────────────────────────────────┐
│  Add Mailchimp Connection                               │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Connection Name  [________________________]            │
│                                                         │
│  ── Config ──                                           │
│                                                         │
│  Data Center *    [us21                    ]            │
│  The suffix after the dash in your API key              │
│  (e.g., key "abc123-us21" → data center "us21").        │
│  API base URL: https://{dc}.api.mailchimp.com/3.0       │
│                                                         │
│  ── Credentials ──                                      │
│                                                         │
│  API Key *        [••••••••••••••••••••••••]            │
│                                                         │
│                            [Cancel]  [Connect]          │
└─────────────────────────────────────────────────────────┘
```

**Config fields:**

| Field | Label | Type | Required | Placeholder / Options |
|-------|-------|------|----------|-----------------------|
| `data_center` | Data Center | string | yes | `us21` |

**Credential fields:**

| Field | Label | Type | Required | Placeholder |
|-------|-------|------|----------|-------------|
| `api_key` | API Key | password | yes | `abc123def-us21` |

**Design note on data center:** Two options considered:
1. **Select dropdown** with all known DCs (`us1`-`us21`) -- prevents typos but may not cover future DCs.
2. **Free text field** with hint -- more flexible, risk of typos.

**Recommended: free text string field** with a `description` hint explaining how to find the DC from the API key. This avoids maintaining a potentially-stale list and handles edge cases (new DCs, non-us regions).

**No `proxyConfig`.** The base URL is dynamic: `https://{data_center}.api.mailchimp.com/3.0`. Auth is HTTP Basic with any-username + API key as password.

**Env var suffixes:** `API_KEY`, `DATA_CENTER`

**Env var mapping logic:**
```typescript
case 'mailchimp':
  if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
  if (str(config.data_center)) set('DATA_CENTER', str(config.data_center)!);
  break;
```

---

### 6. PostHog

- **Type:** `posthog`
- **Category:** `saas`
- **Description:** "Product analytics with PostHog"

```
┌─────────────────────────────────────────────────────────┐
│  Add PostHog Connection                                 │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Connection Name  [________________________]            │
│                                                         │
│  ── Config ──                                           │
│                                                         │
│  Host URL *       [                            ]        │
│  US Cloud: https://us.posthog.com                       │
│  EU Cloud: https://eu.posthog.com                       │
│  Self-hosted: your instance URL                         │
│                                                         │
│  Project ID       [12345                       ]        │
│                                                         │
│  ── Credentials ──                                      │
│                                                         │
│  Personal API     [••••••••••••••••••••••••]            │
│  Key *                                                  │
│                                                         │
│                            [Cancel]  [Connect]          │
└─────────────────────────────────────────────────────────┘
```

**Config fields:**

| Field | Label | Type | Required | Placeholder | Description |
|-------|-------|------|----------|-------------|-------------|
| `host` | Host URL | string | yes | `https://us.posthog.com` | "US Cloud: `https://us.posthog.com` · EU Cloud: `https://eu.posthog.com` · Self-hosted: your instance URL" |
| `project_id` | Project ID | string | no | `12345` | — |

**Implementation note on region:** The ideal UX is a region selector that auto-fills the host field. However, the current `ConfigField` schema only supports `string`, `number`, `boolean`, and `select` types -- there's no "conditional field" mechanism. Two pragmatic approaches:

1. **Simple (recommended for this iteration):** Make `host` a required string field with a clear placeholder (`https://us.posthog.com`). Add a `description` hint: "US Cloud: `https://us.posthog.com` | EU Cloud: `https://eu.posthog.com` | Self-hosted: your instance URL". The user pastes the correct URL.

2. **Select + text:** Add a `region` select field with US/EU/Self-Hosted options, and a separate `host` text field. The agent ignores `region` and uses `host` for API calls. This adds UX clarity but the host field still needs to be manually correct for self-hosted.

**Go with approach 1** -- a required `host` field with descriptive help text. Simple, correct, no silent failures.

**Credential fields:**

| Field | Label | Type | Required | Placeholder |
|-------|-------|------|----------|-------------|
| `api_key` | Personal API Key | password | yes | `phx_...` |

**No `proxyConfig`.**

**Env var suffixes:** `API_KEY`, `HOST`, `PROJECT_ID`

**Env var mapping logic:**
```typescript
case 'posthog':
  if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
  if (str(config.host)) set('HOST', str(config.host)!);
  if (str(config.project_id)) set('PROJECT_ID', str(config.project_id)!);
  break;
```

---

### 7. Typeform

- **Type:** `typeform`
- **Category:** `saas`
- **Description:** "Forms and surveys with Typeform"

**Config fields:** None

**Credential fields:**

| Field | Label | Type | Required | Placeholder |
|-------|-------|------|----------|-------------|
| `api_key` | Personal Access Token | password | yes | `tfp_...` |

**No `proxyConfig`.** Base URL is always `https://api.typeform.com`.

**Env var suffixes:** `API_KEY` (default fallback handles this)

**Env var mapping logic:**
```typescript
// Falls through to default case: set('API_KEY', ...)
// No custom case needed
```

---

### 8. Mixpanel

- **Type:** `mixpanel`
- **Category:** `saas`
- **Description:** "Product analytics with Mixpanel"

Uses **Service Account** authentication (Option A). Project Secrets are deprecated per Mixpanel dev docs. Service Accounts use HTTP Basic auth and cover the Query API, Raw Data Export, Lookup Tables, Schemas, Data Pipelines, and GDPR/CCPA endpoints.

```
┌─────────────────────────────────────────────────────────┐
│  Add Mixpanel Connection                                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Connection Name  [________________________]            │
│                                                         │
│  ── Config ──                                           │
│                                                         │
│  Project ID *     [1234567                 ]            │
│                                                         │
│  Region *         [ US ▼ ]                              │
│                   ┌───────────────────────────────┐     │
│                   │ ○ US                          │     │
│                   │   mixpanel.com                │     │
│                   │ ○ EU                          │     │
│                   │   eu.mixpanel.com             │     │
│                   └───────────────────────────────┘     │
│                                                         │
│  ── Credentials ──                                      │
│                                                         │
│  Service Account  [myapp.abc123.mp-servic… ]            │
│  Username *                                             │
│                                                         │
│  Service Account  [••••••••••••••••••••••••]            │
│  Secret *                                               │
│                                                         │
│  ℹ Create a Service Account in Organization Settings    │
│  → Service Accounts. The secret is shown only once      │
│  at creation time — save it immediately.                │
│                                                         │
│                            [Cancel]  [Connect]          │
└─────────────────────────────────────────────────────────┘
```

**Config fields:**

| Field | Label | Type | Required | Default | Options / Placeholder |
|-------|-------|------|----------|---------|----------------------|
| `project_id` | Project ID | string | yes | — | `1234567` |
| `region` | Region | select | yes | `us` | `us` → "US (mixpanel.com)", `eu` → "EU (eu.mixpanel.com)" |

**Design note on region:** Mixpanel also has an India region (`in.mixpanel.com`), but it is rarely used. Including only US and EU covers the vast majority of users. If India support is needed later, it can be added as a third option with no breaking change.

**Credential fields:**

| Field | Label | Type | Required | Placeholder | Description |
|-------|-------|------|----------|-------------|-------------|
| `api_key` | Service Account Username | text | yes | — | — |
| `api_secret` | Service Account Secret | password | yes | — | "Create a Service Account in Organization Settings → Service Accounts. The secret is shown only once at creation time." |

**No `proxyConfig`.** Auth is HTTP Basic (`username:secret`). The base URL depends on region:
- US: `https://mixpanel.com/api` (Query), `https://data.mixpanel.com/api` (Export)
- EU: `https://eu.mixpanel.com/api` (Query), `https://data-eu.mixpanel.com/api` (Export)

The agent constructs the correct URL from the `REGION` env var.

**Env var suffixes:** `USERNAME`, `SECRET`, `PROJECT_ID`, `REGION`

**Env var mapping logic:**
```typescript
case 'mixpanel':
  if (str(credentials.api_key)) set('USERNAME', str(credentials.api_key)!);
  if (str(credentials.api_secret)) set('SECRET', str(credentials.api_secret)!);
  if (str(config.project_id)) set('PROJECT_ID', str(config.project_id)!);
  if (str(config.region)) set('REGION', str(config.region)!);
  break;
```

**Reference: Mixpanel Service Account auth pattern:**
```bash
# HTTP Basic auth with Service Account credentials
curl "https://mixpanel.com/api/2.0/insights?project_id=12345" \
  --user "sa_username:sa_secret"

# Or with Authorization header (base64-encoded)
curl "https://mixpanel.com/api/2.0/insights?project_id=12345" \
  -H "Authorization: Basic $(echo -n 'sa_username:sa_secret' | base64)"
```

**Endpoints accessible with Service Account auth:**
- Query API: `/api/2.0/insights`, `/api/2.0/funnels`, `/api/2.0/retention`, etc.
- Raw Data Export: `data.mixpanel.com/api/2.0/export`
- Lookup Tables, Lexicon Schemas, Data Pipelines, GDPR/CCPA

**Rate limits:** 5 concurrent queries, 60 queries/hour (Query API). 100 concurrent, 60/hour (Export API).

---

## Audit: Existing Templates

All 8 pre-existing API-key templates were audited for correctness and consistency with the no-proxy pattern.

### Summary

| Template | `proxyConfig` Removal | Env Var Mapping | Schema Issues | Severity |
|----------|----------------------|-----------------|---------------|----------|
| **Linear** | Remove | Correct | None | Low |
| **GitHub** | Remove | Correct | None | Low |
| **OpenAI** | Remove | Missing `ORGANIZATION_ID` | Remove stale `default_model` field | Medium |
| **Anthropic** | Remove | Correct | None | Low |
| **HubSpot** | Remove | Correct | None | Low |
| **SendGrid** | Remove | Correct | None | Low |
| **Twilio** | Remove | **BROKEN** | Credential field name mismatch, redundant config field | **High** |
| **Airtable** | Remove | Correct | None | Low |

---

### All Templates: Remove `proxyConfig`

Remove the `proxyConfig` block from every existing API-key template. This is a global decision: all integrations use the env-vars-only pattern. The agent/app calls vendor APIs directly.

Templates to strip `proxyConfig` from:
- `linear` (was: bearer to `api.linear.app`)
- `github` (was: bearer to `api.github.com` + default headers)
- `openai` (was: bearer to `api.openai.com` + org header)
- `anthropic` (was: custom `x-api-key` header to `api.anthropic.com` + version header)
- `hubspot` (was: bearer to `api.hubapi.com`)
- `sendgrid` (was: bearer to `api.sendgrid.com`)
- `twilio` (was: basic auth to `api.twilio.com`)
- `airtable` (was: bearer to `api.airtable.com`)

Also strip `proxyConfig` from `stripe` (was: bearer to `api.stripe.com` + version header).

Note: `salesforce` (OAuth), `notion` (OAuth), and `slack` (OAuth) also have `proxyConfig`. These should be stripped too for consistency, but are out of scope if we want to limit risk. **Recommendation: strip from all templates in one pass.**

**Dead code after proxy removal:** Once `proxyConfig` is removed from all templates, the `ProxyConfig` interface, `isProxyable()` helper, and any proxy-related code in `integration-registry.ts` become dead code. **Recommendation: delete them in the same pass** to avoid leaving unused types and functions in the codebase. The proxy execution code in the worker (`cf-api-proxy.ts` or similar) is a separate concern and can be cleaned up independently.

---

### Twilio: Broken Env Var Mapping (BUG)

**This is a live bug.** The env vars `INT_TWILIO_*_ACCOUNT_SID` and `INT_TWILIO_*_AUTH_TOKEN` are never set.

**Root cause:** The credential schema defines fields named `api_key` and `api_secret`, but the env var mapping in `integration-env.ts` reads `credentials.account_sid` and `credentials.auth_token` — field names that don't exist in the stored credentials.

```
Registry credentialSchema:        Env var mapping reads:
─────────────────────────         ─────────────────────
api_key    → "Account SID"        credentials.account_sid  ← MISS
api_secret → "Auth Token"         credentials.auth_token   ← MISS
```

Additionally, `account_sid` appears redundantly in both `configSchema` AND `credentialSchema` (as `api_key`).

**Fix:** Rename the credential fields to match what the env var mapping expects, and remove the redundant config field.

**Before:**
```typescript
twilio: {
  configSchema: [
    { name: 'account_sid', label: 'Account SID', type: 'string', required: true },  // REDUNDANT
  ],
  credentialSchema: [
    { name: 'api_key', label: 'Account SID', type: 'text', required: true },        // WRONG NAME
    { name: 'api_secret', label: 'Auth Token', type: 'password', required: true },   // WRONG NAME
  ],
  proxyConfig: { ... },  // REMOVE
}
```

**After:**
```typescript
twilio: {
  configSchema: [],  // account_sid moved to credentials where it belongs
  credentialSchema: [
    { name: 'account_sid', label: 'Account SID', type: 'text', required: true },
    { name: 'auth_token', label: 'Auth Token', type: 'password', required: true },
  ],
  // No proxyConfig
}
```

The env var mapping already expects `credentials.account_sid` and `credentials.auth_token`, so it will now work correctly.

**Migration note:** Any existing Twilio connections have credentials stored with keys `api_key` and `api_secret`. The env var mapping fix means those old connections will also not map correctly until they are re-saved. This is acceptable because they were already broken (env vars were never set). Users will need to edit and re-save their Twilio connection after this change. The `getEnvVarSuffixesForType` already returns `['ACCOUNT_SID', 'AUTH_TOKEN']`, which is correct.

---

### OpenAI: Stale `default_model` Field + Missing Env Var

**Issue 1: `default_model` config field**

The `default_model` field defaults to `gpt-4`, which is outdated. More importantly, this field is not an API parameter — it's an opinionated application-level default that doesn't map to any env var and serves no purpose without the proxy layer.

**Fix:** Remove the `default_model` config field entirely.

**Issue 2: `organization_id` not exposed as env var**

The `organization_id` config field exists in the schema but is never mapped to an env var. Without proxy (which used it as the `OpenAI-Organization` header), the only way to use it is through an env var.

**Fix:** Add `ORGANIZATION_ID` to the env var mapping and suffixes.

**Before:**
```typescript
openai: {
  configSchema: [
    { name: 'organization_id', label: 'Organization ID', type: 'string', required: false },
    { name: 'default_model', label: 'Default Model', type: 'string', required: false, default: 'gpt-4' },  // REMOVE
  ],
  proxyConfig: { ... },  // REMOVE
}

// integration-env.ts
case 'openai':
  if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
  break;  // MISSING: organization_id
```

**After:**
```typescript
openai: {
  configSchema: [
    { name: 'organization_id', label: 'Organization ID', type: 'string', required: false },
  ],
  // No proxyConfig
}

// integration-env.ts
case 'openai':
  if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
  if (str(config.organization_id)) set('ORGANIZATION_ID', str(config.organization_id)!);
  break;
```

Update `getEnvVarSuffixesForType`: change from shared `['API_KEY']` group to own case returning `['API_KEY', 'ORGANIZATION_ID']`.

---

### Linear, GitHub, Anthropic, HubSpot, SendGrid, Airtable: Clean

These templates only need `proxyConfig` removed. Their credential schemas and env var mappings are correct.

| Template | Credential Field(s) | Env Var(s) | Status |
|----------|---------------------|------------|--------|
| Linear | `api_key` | `API_KEY` | Correct |
| GitHub | `api_key` (labeled "Personal Access Token") | `TOKEN` | Correct |
| Anthropic | `api_key` | `API_KEY` | Correct |
| HubSpot | `api_key` (labeled "Private App Token") | `API_KEY` | Correct |
| SendGrid | `api_key` | `API_KEY` | Correct |
| Airtable | `api_key` (labeled "Personal Access Token") | `API_KEY` | Correct |

---

## Stripe: `api_version` Config Field

The `api_version` config field on Stripe was only used by the proxy to set the `Stripe-Version` header. With the proxy removed, this field serves no purpose — it's not exposed as an env var and the agent/app will set API version via the Stripe SDK or request headers directly.

**Fix:** Remove the `api_version` config field from the Stripe template and clear `configSchema` to `[]`. Add this to the Phase 2 checklist.

---

## Category Assignments

All new templates map to existing categories. No new `IntegrationCategory` values needed.

| Template | Category |
|----------|----------|
| Supabase | `databases` |
| Databricks | `databases` |
| Sentry | `saas` |
| OpenRouter | `ai_services` |
| Mailchimp | `saas` |
| PostHog | `saas` |
| Mixpanel | `saas` |
| Typeform | `saas` |

---

## File Changes

| File | Change | Scope |
|------|--------|-------|
| `src/lib/integration-registry.ts` | Add 8 new entries. Add optional `description` to `CredentialField` and `ConfigField`. Remove `proxyConfig` from ALL existing templates (stripe, openai, anthropic, github, linear, sendgrid, twilio, salesforce, airtable, hubspot, notion, slack). Fix twilio credential schema. Remove openai `default_model`. | Primary work |
| `workers/main/src/integration-env.ts` | Add `case` blocks for supabase, databricks, sentry, mailchimp, posthog, mixpanel. Fix openai case to expose `ORGANIZATION_ID`. Twilio mapping already correct (will work once credential field names are fixed). | Env var mapping |
| `src/components/pages/connections/AddConnectionDialog.tsx` | Render `field.description` as help text under inputs when present. `<p className="text-xs text-muted-foreground">` below each input. | UI hint rendering |
| `src/components/pages/connections/EditConnectionDialog.tsx` | Same `description` rendering as AddConnectionDialog. | UI hint rendering |

Files that need **NO** changes:
- `src/lib/integration-icons.tsx` -- All 8 logos already registered
- `public/logos/` -- All 8 SVG files already exist
- `src/types.ts` -- No new categories or auth methods
- `src/routes/_app.connections.tsx` -- No changes needed

---

## Implementation Checklist

### Phase 1: Schema Enhancement (small, reusable)

- [ ] Add optional `description?: string` to `CredentialField` interface in `src/lib/integration-registry.ts`
- [ ] Add optional `description?: string` to `ConfigField` interface in `src/lib/integration-registry.ts`
- [ ] Render `field.description` as help text under inputs in `AddConnectionDialog.tsx` (muted text, `text-xs text-muted-foreground`, only when description exists)
- [ ] Render `field.description` as help text under inputs in `EditConnectionDialog.tsx` (same pattern)

### Phase 2: Fix Existing Templates

- [ ] Remove `proxyConfig` from `stripe`. Remove stale `api_version` config field (was only used by proxy).
- [ ] Remove `proxyConfig` from `openai`. Remove `default_model` config field.
- [ ] Remove `proxyConfig` from `anthropic`
- [ ] Remove `proxyConfig` from `github`
- [ ] Remove `proxyConfig` from `linear`
- [ ] Remove `proxyConfig` from `sendgrid`
- [ ] Remove `proxyConfig` from `airtable`
- [ ] Remove `proxyConfig` from `hubspot`
- [ ] Remove `proxyConfig` from `salesforce` (OAuth — keep `oauthConfig`, just strip `proxyConfig`)
- [ ] Remove `proxyConfig` from `notion` (OAuth — keep `oauthConfig`, just strip `proxyConfig`)
- [ ] Remove `proxyConfig` from `slack` (OAuth — keep `oauthConfig`, just strip `proxyConfig`)
- [ ] Delete the `ProxyConfig` interface, `isProxyable()` helper, and `proxyConfig` field from the `IntegrationDefinition` type (now dead code with all proxyConfigs removed)
- [ ] **Fix Twilio (BUG):** Remove `proxyConfig`. Remove redundant `account_sid` from `configSchema`. Rename credential fields from `api_key`/`api_secret` to `account_sid`/`auth_token` so env var mapping works.
- [ ] **Fix OpenAI env var mapping:** Add `organization_id` → `ORGANIZATION_ID` to `mapCredentialsToEnvVars`. Move `openai` out of the shared `['API_KEY']` group in `getEnvVarSuffixesForType` to its own case returning `['API_KEY', 'ORGANIZATION_ID']`.

### Phase 3: Add New Registry Definitions

- [ ] Add `supabase` to `INTEGRATION_REGISTRY` -- include `key_type` select with anon/service_role options and `description` on the select warning about RLS bypass
- [ ] Add `databricks` to `INTEGRATION_REGISTRY`
- [ ] Add `sentry` to `INTEGRATION_REGISTRY` -- include `description` on auth token credential with scope guidance: "Create an Organization Auth Token at Settings > Auth Tokens. Recommended scopes: project:read, org:read, event:read."
- [ ] Add `openrouter` to `INTEGRATION_REGISTRY`
- [ ] Add `mailchimp` to `INTEGRATION_REGISTRY` -- include `data_center` config field with `description`: "The suffix after the dash in your API key (e.g., key abc123-us21 means data center us21). API base: https://{dc}.api.mailchimp.com/3.0"
- [ ] Add `posthog` to `INTEGRATION_REGISTRY` -- `host` is required, with `description`: "US Cloud: https://us.posthog.com | EU Cloud: https://eu.posthog.com | Self-hosted: your instance URL"
- [ ] Add `mixpanel` to `INTEGRATION_REGISTRY` -- `region` select (US/EU), `project_id` required, Service Account credentials with `description` about one-time secret visibility
- [ ] Add `typeform` to `INTEGRATION_REGISTRY`

### Phase 4: Env Var Mapping (new templates)

- [ ] Add `supabase` case to `getEnvVarSuffixesForType` → `['API_KEY', 'PROJECT_URL', 'KEY_TYPE']`
- [ ] Add `supabase` case to `mapCredentialsToEnvVars` → map `api_key` + `config.project_url` + `config.key_type`
- [ ] Add `databricks` case to `getEnvVarSuffixesForType` → `['API_KEY', 'WORKSPACE_URL']`
- [ ] Add `databricks` case to `mapCredentialsToEnvVars` → map `api_key` + `config.workspace_url`
- [ ] Add `sentry` case to `getEnvVarSuffixesForType` → `['API_KEY', 'ORGANIZATION']`
- [ ] Add `sentry` case to `mapCredentialsToEnvVars` → map `api_key` + `config.organization`
- [ ] Add `mailchimp` case to `getEnvVarSuffixesForType` → `['API_KEY', 'DATA_CENTER']`
- [ ] Add `mailchimp` case to `mapCredentialsToEnvVars` → map `api_key` + `config.data_center`
- [ ] Add `posthog` case to `getEnvVarSuffixesForType` → `['API_KEY', 'HOST', 'PROJECT_ID']`
- [ ] Add `posthog` case to `mapCredentialsToEnvVars` → map `api_key` + `config.host` + `config.project_id`
- [ ] Add `mixpanel` case to `getEnvVarSuffixesForType` → `['USERNAME', 'SECRET', 'PROJECT_ID', 'REGION']`
- [ ] Add `mixpanel` case to `mapCredentialsToEnvVars` → map `api_key` as USERNAME, `api_secret` as SECRET, `config.project_id`, `config.region`
- [ ] Confirm `openrouter` and `typeform` work with existing default case (returns `['API_KEY']`, maps `credentials.api_key`)

### Phase 5: Verification

- [ ] Run `bun run typecheck` -- ensure no type errors
- [ ] Run `bun run test:run` -- ensure existing tests pass
- [ ] Run `bun run build` -- ensure build succeeds

---

## Testing Notes

The existing test suite validates the integration infrastructure (encryption, validation, env var mapping). The new templates use the same code paths and data structures, so they are covered by existing tests.

**Manual verification (recommended):** After deploying, navigate to `/connections`, click "Add Connection", and confirm:
1. All 8 new templates appear with correct logos and in the correct category tabs
2. Supabase shows the key type selector with anon/service_role options
3. Sentry auth token field shows scope guidance text
4. Mailchimp shows data center field with help text
5. PostHog host field is required and shows region help text
6. Mixpanel shows region select (US/EU), project ID, and service account username/secret fields
7. Form validation works (required fields enforced)

No new test files are needed for this change.

---

## Reference: Existing Pattern (Env-Vars Only)

For reference, the simplest possible template with no `proxyConfig`:

```typescript
// Pattern for a simple API-key-only integration (no proxy)
typeform: {
  type: 'typeform',
  displayName: 'Typeform',
  description: 'Forms and surveys with Typeform',
  category: 'saas',
  authMethod: 'api_key',
  configSchema: [],
  credentialSchema: [
    {
      name: 'api_key',
      label: 'Personal Access Token',
      type: 'password',
      required: true,
      placeholder: 'tfp_...',
    },
  ],
  // No proxyConfig -- agent calls https://api.typeform.com directly
},
```

And a more complex template with config fields and descriptions:

```typescript
supabase: {
  type: 'supabase',
  displayName: 'Supabase',
  description: 'Connect to a Supabase project',
  category: 'databases',
  authMethod: 'api_key',
  configSchema: [
    {
      name: 'project_url',
      label: 'Project URL',
      type: 'string',
      required: true,
      placeholder: 'https://your-project.supabase.co',
    },
    {
      name: 'key_type',
      label: 'Key Type',
      type: 'select',
      required: true,
      default: 'anon',
      options: [
        { value: 'anon', label: 'Anon Key (respects RLS)' },
        { value: 'service_role', label: 'Service Role Key (bypasses RLS)' },
      ],
      description: 'Service role keys bypass Row Level Security and have full read/write access to your database. Only use if your application requires admin-level access. Prefer the anon key for client-facing apps.',
    },
  ],
  credentialSchema: [
    {
      name: 'api_key',
      label: 'API Key',
      type: 'password',
      required: true,
      placeholder: 'eyJ...',
    },
  ],
  // No proxyConfig -- agent uses @supabase/supabase-js or REST directly
},
```
