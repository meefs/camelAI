# Custom Domain Troubleshooting — MCP Tool + Skill Plan

**Status: Implemented** (2026-04-14)

## Problem

When users report custom domain issues, the agent has almost no diagnostic information. `get_custom_domain` returns a misleading `status: "active"` (org-level config status) with no visibility into per-app SSL state, required DNS records, or whether DNS is actually resolving. This forces the agent into a slow guessing game using sandbox shell tools that often aren't available (`dig`, `nslookup`), and results in support tickets that escalate to us.

Real example: Caesar Lenz Squire waited 9+ days with a stuck provisioning because the backfill failed silently and no one (human or agent) could see the actual state.

## Goals

1. **One-call diagnosis** — The agent should be able to call a single MCP tool and get everything needed to tell the user exactly what's wrong and how to fix it.
2. **Skill sheet** — The agent should have a custom domain troubleshooting skill loaded into context so it understands the architecture, common failure modes, and how to guide users step by step.
3. **Self-service** — Users should be able to resolve custom domain issues entirely through the agent without filing a support ticket.

---

## Part 1: Improve `get_custom_domain` MCP Tool

### Current return shape

```json
{
  "configured": true,
  "domain": "illiana.me",
  "status": "active",
  "message": "Custom domain: *.illiana.me — apps are accessible at {app-name}.illiana.me"
}
```

### Proposed return shape

```json
{
  "configured": true,
  "domain": "illiana.me",
  "status": "active",
  "dns": {
    "routing_record": {
      "host": "*.illiana.me",
      "type": "CNAME",
      "target": "custom-domains.camelai.app"
    },
    "acme_challenge_record": {
      "host": "_acme-challenge.illiana.me",
      "type": "CNAME",
      "target": "1b7fee6764db9b60.dcv.cloudflare.com"
    }
  },
  "apps": [
    {
      "name": "illiana-homepage",
      "hostname": "illiana-homepage.illiana.me",
      "cf_hostname_id": "abc123",
      "status": "pending",
      "ssl_status": "pending_validation",
      "error": null,
      "updated_at": 1712962800000
    }
  ],
  "message": "Custom domain: *.illiana.me — 0/1 apps have active SSL. See dns and apps fields for details."
}
```

### What changes in the code

**File:** `workers/main/src/mcp-handler.ts` (lines 1540–1558)

The `get_custom_domain` handler needs to:

1. Fetch the DCV delegation UUID via `getDcvDelegationUuid(zoneId, apiToken)` (already used by `set_custom_domain` at line 1622)
2. Compute the DNS target via `getCustomHostnameDnsTarget(...)` (already used by `set_custom_domain` at line 1595)
3. Call `orgStub.listWorkerScripts()` to get per-app custom domain state (the fields `custom_domain_hostname`, `custom_domain_status`, `custom_domain_ssl_status`, `custom_domain_error`, `custom_domain_updated_at` are already on `WorkerScript`)
4. Optionally: trigger a lazy refresh for stale apps before returning (call the same refresh logic from `src/lib/custom-domain.server.ts`)

### Implementation notes

- The tool already has access to `this.env.CF_ZONE_ID`, `this.env.CF_API_TOKEN`, and the org stub — no new bindings needed.
- `listWorkerScripts()` already returns all `custom_domain_*` fields — just need to map them into the response.
- DCV UUID fetch is a single CF API call, fast and cacheable.
- Refresh is optional but valuable: if the agent calls this tool and per-app status is stale (>60s), it should refresh from Cloudflare before responding. This avoids the "reload the page" workaround. Use the existing `refreshWorkerScriptCustomDomainStates()` from `src/lib/custom-domain.server.ts`, or replicate the logic inline since MCP handlers run in the worker context.

### Stretch: DNS resolution check from Cloudflare's perspective

The agent requested the ability to distinguish "record not added" vs. "added but not propagated" vs. "pointing to wrong target." This is harder because:

- Workers can't run `dig`/`nslookup`
- We'd need to use a DNS-over-HTTPS API (e.g., `https://cloudflare-dns.com/dns-query` or `https://dns.google/resolve`)

**Proposal:** Add a lightweight DNS check inside the tool using Cloudflare's DoH endpoint:

```
GET https://cloudflare-dns.com/dns-query?name=_acme-challenge.illiana.me&type=CNAME
Accept: application/dns-json
```

This returns JSON with the CNAME target if the record exists. We can check:
- Routing CNAME: resolve `{appName}.{domain}` and check if it points to the expected target
- ACME CNAME: resolve `_acme-challenge.{domain}` and check if it points to `{uuid}.dcv.cloudflare.com`

This is a `fetch()` call from the worker — no special bindings needed. Add the results to the response:

```json
"dns_checks": {
  "routing_cname": {
    "queried": "illiana-homepage.illiana.me",
    "resolved_target": "custom-domains.camelai.app",
    "expected_target": "custom-domains.camelai.app",
    "ok": true
  },
  "acme_challenge_cname": {
    "queried": "_acme-challenge.illiana.me",
    "resolved_target": null,
    "expected_target": "1b7fee6764db9b60.dcv.cloudflare.com",
    "ok": false
  }
}
```

This gives the agent a complete picture: DNS routing works, ACME challenge is missing → tell user to add the `_acme-challenge` record.

**Note:** Only check DNS for the first app (or a configurable sample) to avoid hammering DoH on orgs with many apps. The routing CNAME is shared across all apps anyway.

---

## Part 2: Skill Sheet — `custom-domain-troubleshooting`

**File:** `sandbox/skills/custom-domain-troubleshooting/SKILL.md`

### Purpose

Give the agent full context on how custom domains work, what can go wrong, and how to guide users through fixes — without needing to discover this through trial and error each time.

### Proposed content outline

```
---
name: custom-domain-troubleshooting
description: Troubleshoot custom domain setup issues. Use when users report SSL errors,
  pending activation, DNS problems, or apps not loading on their custom domain.
---
```

**Sections:**

1. **How custom domains work** (brief)
   - Wildcard subdomain model: one base domain, apps at `{name}.{domain}`
   - Two DNS records needed: routing CNAME + ACME challenge CNAME
   - Per-app Cloudflare custom hostname provisioning
   - URL only switches when BOTH hostname status AND ssl status are "active"

2. **Diagnostic workflow** (step by step)
   - Step 1: Call `get_custom_domain` — check `dns`, `apps`, and `dns_checks`
   - Step 2: Interpret results using the decision tree (below)
   - Step 3: Give the user the specific fix

3. **Decision tree**

   ```
   Is domain configured?
   ├─ No → guide user to Settings > Organization > Domains
   └─ Yes
      ├─ dns_checks.routing_cname.ok?
      │  ├─ No → "Add a CNAME record: * → {target}"
      │  └─ Yes
      │     ├─ dns_checks.acme_challenge_cname.ok?
      │     │  ├─ No → "Add a CNAME record: _acme-challenge.{domain} → {uuid}.dcv.cloudflare.com"
      │     │  └─ Yes
      │     │     ├─ Any app ssl_status = "active"?
      │     │     │  ├─ Yes → working for those apps, others may still be provisioning
      │     │     │  └─ No → all pending
      │     │     │     ├─ How long? < 1 hour → "Still provisioning, wait and retry"
      │     │     │     └─ > 1 hour → suggest remove + re-add domain
      │     │     ├─ App has error? → show the error, suggest remove + re-add
      │     │     └─ App missing from list? → "Deploy the app to create its hostname"
   ```

4. **Common errors and fixes**
   - `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` → ACME challenge CNAME missing
   - `DNS_PROBE_FINISHED_NXDOMAIN` → routing CNAME missing
   - Error 1014 (CNAME Cross-User Banned) → domain is on Cloudflare, CNAME must be DNS-only (gray cloud)
   - `ssl_status: "pending_validation"` for hours → ACME CNAME wrong or CAA records blocking
   - App works on `*.camelai.app` but not custom domain → per-app hostname not yet active
   - Some apps work, others don't → provisioning is per-app, check each app's status

5. **Provider-specific DNS notes**
   - Namecheap: wildcard host is `*.` for apex, `*.subdomain` for subdomain base
   - Cloudflare: CNAME must be gray-clouded (DNS only), not orange-clouded (proxied)
   - GoDaddy, Route53, Google Domains: brief notes on wildcard CNAME support
   - If provider doesn't support wildcard CNAME: create per-app records instead

6. **Escalation**
   - If `get_custom_domain` shows no apps and domain is configured → backfill may have failed, suggest remove + re-add
   - If remove + re-add doesn't fix it → ask user to contact support with the `get_custom_domain` output

---

## Part 3: Implementation Order

### Phase 1 — Improve `get_custom_domain` (do first)
1. Add DNS record info (dcvUuid + dnsTarget) to the response
2. Add per-app hostname status to the response
3. Add fresh-from-Cloudflare refresh for stale apps before responding

### Phase 2 — Add DNS resolution checks
4. Add DoH-based DNS checks for routing CNAME and ACME challenge CNAME
5. Include check results in the response

### Phase 3 — Write the skill sheet
6. Create `sandbox/skills/custom-domain-troubleshooting/SKILL.md` with the content outlined above
7. Test end-to-end: set up a custom domain, call `get_custom_domain`, verify the agent can diagnose and guide through fixes

### Phase 4 — Validate with real troubleshooting
8. Use the improved tool + skill to troubleshoot Illiana's `illiana.me` domain
9. Use it to diagnose what went wrong for Caesar's `spacepiegroup.com` (if still unresolved)
10. Iterate on the skill sheet based on what works and what's missing

---

## Implementation Summary

### Files changed

- **`workers/main/src/mcp-handler.ts`**
  - `get_custom_domain` — rewritten to return DNS records, per-app status with stale refresh, and live DoH-based DNS resolution checks
  - `retry_custom_domain_hostnames` — new tool that re-provisions failed/missing Cloudflare hostnames without remove+re-add
  - `resolveCnameViaDoH()` — new helper that resolves CNAME records via Cloudflare DoH (`cloudflare-dns.com/dns-query`)

- **`sandbox/skills/custom-domain-troubleshooting/SKILL.md`** — new skill sheet with architecture overview, diagnostic workflow, decision tree, common errors, provider notes, and escalation path

### Design decisions

- **DoH rate limiting**: Only checks DNS for the first app (routing CNAME) + the base domain ACME record. The routing CNAME is shared across all apps, so one check is sufficient.
- **Retry tool**: `retry_custom_domain_hostnames` skips apps that are already active and only retries apps with no hostname ID, errors, or failed status. Lighter than remove+re-add.
- **Stale refresh**: `get_custom_domain` refreshes stale app statuses (>60s) directly from Cloudflare API before responding, so the agent always sees current data.
