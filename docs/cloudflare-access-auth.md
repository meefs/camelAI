# Cloudflare Access Auth

camelAI can accept Cloudflare Access identity without disabling its normal login
page. When an unauthenticated request includes a verified Access JWT, the app
creates the same signed session cookie used by password and OAuth login. If
Access headers are absent, or Access is not configured, normal login continues.

Minimal configuration:

```bash
CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=your-access-application-aud
```

The app verifies the JWT issuer, signature, expiry, and audience before trusting
Access identity data. `CLOUDFLARE_ACCESS_AUDS` can be used instead of, or in
addition to, `CLOUDFLARE_ACCESS_AUD` for comma-separated application audiences.

Org creation is configurable so the integration can work with Entra ID or another
IdP without code changes:

```bash
# Optional guardrail.
CLOUDFLARE_ACCESS_REQUIRED_EMAIL_DOMAIN=example.com

# Create orgs from selected identity claims. Defaults are idp.name, idp.id,
# and officeLocation. Use explicit group claims only when groups should map to orgs.
CLOUDFLARE_ACCESS_ORG_CLAIMS=idp.name,officeLocation

# Map prefixed SSO groups to orgs. Example group: camelai-office-austin.
CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX=camelai-office-
CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX=camelai-office-admin-

# Optional exact value to friendly org-name map. Keys can be Entra group ids,
# office ids, or any stable value present in the Access JWT/identity response.
CLOUDFLARE_ACCESS_ORG_MAP={"8f1e...":"Austin Office","7c2a...":"Dallas Office"}

# Optional fallback if no configured claim/group/map produces an org.
CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME=Default Organization
```

Cloudflare Access's `/cdn-cgi/access/get-identity` endpoint is fetched from the
protected application origin best-effort after JWT verification, so richer IdP
fields can be used for org mapping. Missing full identity data does not break
login if the verified JWT has enough configured claims to map the user to an org.

Deployment-wide Cloudflare Access authentication is separate from product
enterprise SSO. Per-organization customer SSO uses direct OIDC; see
[Enterprise OIDC SSO](./enterprise-oidc-sso.md).
