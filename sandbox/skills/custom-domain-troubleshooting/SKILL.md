---
name: custom-domain-troubleshooting
description: Diagnoses and resolves custom domain issues including SSL errors, pending activation, and DNS misconfigurations. Use when users report ERR_SSL_VERSION_OR_CIPHER_MISMATCH, DNS errors, apps not loading on their custom domain, or ask about custom domain setup.
---

# Custom Domain Troubleshooting

Custom domains let an org serve all their deployed apps under a single base domain. Instead of `https://{app-name}-{org-slug}.camelai.app`, apps become `https://{app-name}.{base-domain}`.

## How It Works

- **Wildcard subdomain model**: one base domain, every app gets a subdomain under it.
- `apps.acme.com` as a base domain gives `signup.apps.acme.com`, `dashboard.apps.acme.com`, etc.
- The subdomain always matches the app name. There is no way to map a custom subdomain to a different app.
- One domain per org. Setting a new one replaces the old one.
- You **cannot** serve an app at the base domain itself (no subdomain prefix).

## Required DNS Records

Two DNS records must be added at the user's DNS provider:

### Record 1: Routing CNAME

Routes all app traffic to camelAI's dispatcher.

| Field  | Value                              |
|--------|------------------------------------|
| Host   | `*` (wildcard, relative to base)   |
| Type   | CNAME                              |
| Target | Shown by `get_custom_domain` → `dns.routing_record.target` |

If the user's provider doesn't support wildcard CNAMEs, they can create individual records per app: `{app-name}` CNAME `{target}`.

### Record 2: ACME Challenge CNAME (SSL Validation)

Delegates SSL certificate issuance to Cloudflare.

| Field  | Value                                                   |
|--------|---------------------------------------------------------|
| Host   | `_acme-challenge.{base-domain}`                         |
| Type   | CNAME                                                   |
| Target | Shown by `get_custom_domain` → `dns.acme_challenge_record.target` |

This is a **single** record at the base domain level. It covers certificate validation for all app subdomains via Cloudflare's DCV delegation.

## When the Custom Domain URL Appears

The custom domain URL for an app only appears when **all** of these are true:

1. The org has a custom domain configured
2. The app's hostname matches `{app-name}.{base-domain}`
3. The app's `status` is `active`
4. The app's `ssl_status` is `active`

Until then, the app uses its default `*.camelai.app` URL.

## Diagnostic Workflow

### Step 1: Call `get_custom_domain`

This returns everything needed for diagnosis:

- `dns.routing_record` / `dns.acme_challenge_record` — the exact records the user needs
- `dns_checks.routing_cname` / `dns_checks.acme_challenge_cname` — live DNS resolution results
- Each DNS check has `status = "ok" | "mismatch" | "missing" | "unavailable"`
- `ok: null` means the DNS diagnostic failed, not that the user's DNS is wrong
- `apps[]` — per-app `status`, `ssl_status`, and `error`

### Step 2: Follow the Decision Tree

```
Is domain configured?
├─ No → Guide user to Settings > Organization > Domains, or use set_custom_domain
└─ Yes
   ├─ dns_checks.routing_cname.status = "unavailable"?
   │  └─ Automatic DNS check failed. Do not say the user's DNS is wrong.
   │     Tell them the expected record from dns.routing_record and ask them to verify it manually, then retry.
   │
   ├─ dns_checks.routing_cname.status = "missing" | "mismatch"?
   │  └─ "Add or fix the CNAME record: *.{domain} → {target}"
   │     Tell the user the exact host and target from dns.routing_record
   │
   ├─ dns_checks.acme_challenge_cname.status = "unavailable"?
   │  └─ Automatic DNS check failed. Do not claim the ACME record is missing.
   │     Tell them the expected record from dns.acme_challenge_record and ask them to verify it manually, then retry.
   │
   ├─ dns_checks.acme_challenge_cname.status = "missing" | "mismatch"?
   │  └─ "Add a CNAME record: _acme-challenge.{domain} → {target}"
   │     Tell the user the exact host and target from dns.acme_challenge_record
   │     This is the #1 cause of SSL errors.
   │
   ├─ dns_checks both status = "ok", but apps have ssl_status != "active"?
   │  ├─ ssl_status = "pending_validation" for < 1 hour → Still provisioning, wait
   │  ├─ ssl_status = "pending_validation" for > 1 hour → Check CAA records (see below)
   │  └─ ssl_status = "failed" → Try retry_custom_domain_hostnames
   │
   ├─ Apps have null status (no Cloudflare hostname)?
   │  └─ Backfill failed. Call retry_custom_domain_hostnames to provision them.
   │
   └─ Apps have status = "active" AND ssl_status = "active"?
      └─ Working! The custom domain URL should appear. Ask user to hard-refresh.
```

### Step 3: Give the User the Specific Fix

Always provide the **exact DNS record** values from `get_custom_domain`. Don't make users look them up in settings.

## Common Errors and Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` | ACME challenge CNAME missing → no SSL cert | Add `_acme-challenge` CNAME |
| `DNS_PROBE_FINISHED_NXDOMAIN` | Routing CNAME missing → DNS doesn't resolve | Add wildcard CNAME |
| Error 1014 (CNAME Cross-User Banned) | Domain is on Cloudflare, CNAME is proxied (orange cloud) | Set CNAME to DNS-only (gray cloud) |
| `ssl_status: "pending_validation"` for hours | ACME CNAME wrong, not propagated, or CAA records blocking | Verify ACME target; check CAA records |
| Some apps work, others don't | Per-app provisioning; some hostnames may have failed | Check each app's status; use retry tool |
| App works on `*.camelai.app` but not custom domain | Per-app hostname not yet active | Wait for provisioning or retry |

## CAA Records

If the domain has CAA DNS records, they must allow Cloudflare's certificate authorities:

```
CAA 0 issue "comodoca.com"
CAA 0 issue "digicert.com"
CAA 0 issue "letsencrypt.org"
CAA 0 issue "pki.goog"
```

Most domains don't have CAA records (which means all CAs are allowed). But if they do and the list doesn't include Cloudflare's CAs, SSL provisioning will silently fail.

## DNS Provider Notes

- **Namecheap**: Wildcard host is `*.` for apex domain, `*.subdomain` for subdomain base domains.
- **Cloudflare**: CNAME **must** be DNS-only (gray cloud icon), **not** Proxied (orange cloud). Proxied CNAMEs cause Error 1014 cross-account conflicts.
- **GoDaddy / Route53 / Google Domains**: Standard wildcard CNAME support. No special notes.
- **Providers without wildcard CNAME support**: Create individual CNAME records per app instead.

## Available Tools

| Tool | Purpose |
|------|---------|
| `get_custom_domain` | Full diagnostic: DNS records, live DNS checks, per-app SSL status |
| `set_custom_domain` | Set or change the custom domain (admin only) |
| `remove_custom_domain` | Remove custom domain, revert to *.camelai.app URLs |
| `retry_custom_domain_hostnames` | Re-provision failed/missing Cloudflare hostnames without removing the domain |

## Escalation

If `retry_custom_domain_hostnames` doesn't resolve the issue and DNS checks pass, advise the user to:

1. Remove the domain (Settings or `remove_custom_domain`)
2. Re-add it (this does a full clean wipe and re-provision)
3. Wait 10-15 minutes, then check status again

If that still doesn't work, the user should contact support with the output of `get_custom_domain`.
