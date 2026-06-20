# Pomerium Auth

camelAI can accept [Pomerium](https://www.pomerium.com/) identity for self-hosted
installs, the same way it accepts Cloudflare Access. When an unauthenticated
request includes a verified Pomerium assertion JWT, the app creates the same
signed session cookie used by password and OAuth login. If the assertion header
is absent, or Pomerium is not configured, normal login continues.

This is the self-hosted counterpart to [Cloudflare Access auth](./cloudflare-access-auth.md):
put Pomerium in front of the app and users are logged in automatically. Both
share the same provider-agnostic engine
(`workers/main/src/helpers/proxy-auth-core.ts`); Pomerium is one adapter
(`pomerium-session.ts`), Cloudflare Access the other.

## How it differs from Cloudflare Access

- Pomerium forwards its signed assertion in the `X-Pomerium-Jwt-Assertion`
  header, signed with **ES256** (ECDSA P-256). Cloudflare Access uses RS256.
- The user's email, name, and **groups are embedded in the signed JWT**, so
  there is no separate identity round-trip (Cloudflare Access fetches a
  `get-identity` endpoint).
- Logout redirects to Pomerium's `/.pomerium/sign_out`.

## Pomerium route prerequisite

The Pomerium route that fronts the app **must enable identity-header
pass-through**, otherwise Pomerium does not forward the
`X-Pomerium-Jwt-Assertion` header and auto-login silently does nothing (the app
sees no assertion and falls through to normal login):

```yaml
routes:
  - from: https://app.your-domain.com
    to: http://app-upstream:3001
    pass_identity_headers: true   # required — forwards X-Pomerium-Jwt-Assertion
    policy:
      - allow:
          and:
            - domain:
                is: example.com
```

See Pomerium's [Pass Identity Headers](https://www.pomerium.com/docs/reference/routes/pass-identity-headers-per-route)
reference. The remaining config below tells camelAI how to verify that header.

## Minimal configuration

```bash
# JWKS source: either point at the authenticate service (the JWKS path
# /.well-known/pomerium/jwks.json is derived) ...
POMERIUM_AUTHENTICATE_URL=https://authenticate.your-domain.com
# ... or set the full JWKS URL directly (takes precedence):
# POMERIUM_JWKS_URL=https://authenticate.your-domain.com/.well-known/pomerium/jwks.json

# `aud` is the route host Pomerium fronts. `iss` is usually the same route host,
# but some Pomerium versions/configs set it to the authenticate service host
# instead — decode a real token and set POMERIUM_ISSUER to whatever `iss` is (see
# the note below).
POMERIUM_ISSUER=app.your-domain.com
POMERIUM_AUDIENCE=app.your-domain.com
```

The app verifies the JWT issuer, ES256 signature, expiry, and audience before
trusting any identity data. `POMERIUM_AUDIENCE` is a comma-separated list, so
multiple route hosts can share one install.

> Verification is an **exact string match** (`proxy-auth-core.ts`), so the env
> values must equal the token's claims byte-for-byte — bare hostnames with no
> scheme and no path (e.g. `app.your-domain.com`, not
> `https://app.your-domain.com/`). `aud` is the **route host**; `iss` is
> **usually** the same route host, but some Pomerium versions/configs set it to
> the **authenticate service host** (e.g. `authenticate.your-domain.com` —
> compare Pomerium's [identity docs](https://www.pomerium.com/docs/capabilities/getting-users-identity),
> which show the route host for both, against the [JS SDK example](https://github.com/pomerium/js-sdk),
> which uses the authenticate host for `iss`). Always confirm against a real
> token from your deployment by decoding the `X-Pomerium-Jwt-Assertion` header
> (or using Pomerium's verify app) and set `POMERIUM_ISSUER` to whatever the
> token's `iss` actually is; if either claim differs, every assertion is
> rejected and auto-login fails closed.

## Org mapping

Org creation is configurable so the integration can work with any IdP behind
Pomerium without code changes. Groups arrive inline in the assertion, so group
prefixes are the most common mapping:

```bash
# Optional guardrail.
POMERIUM_REQUIRED_EMAIL_DOMAIN=example.com

# Create orgs from selected identity claims. Defaults are idp.name, idp.id,
# and officeLocation. Use explicit group claims only when groups should map to orgs.
POMERIUM_ORG_CLAIMS=idp.name,officeLocation

# Map prefixed SSO groups to orgs. Example group: camelai-office-austin.
POMERIUM_ORG_GROUP_PREFIX=camelai-office-
POMERIUM_ADMIN_GROUP_PREFIX=camelai-office-admin-

# Optional exact value to friendly org-name map. Keys can be group ids or any
# stable value present in the Pomerium assertion.
POMERIUM_ORG_MAP={"8f1e...":"Austin Office","7c2a...":"Dallas Office"}

# Optional fallback if no configured claim/group/map produces an org.
POMERIUM_DEFAULT_ORG_NAME=Default Organization
```

On self-hosted runtimes, mapped orgs are upgraded to the `enterprise` billing
plan automatically (Stripe is bypassed), the same as Cloudflare Access.
