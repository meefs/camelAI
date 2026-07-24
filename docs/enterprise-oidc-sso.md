# Enterprise OIDC SSO

Enterprise organizations can connect camelAI directly to an OpenID Connect
provider without using Cloudflare Access as an identity broker.

## Setup

An organization admin opens **Settings → Organization → SSO**, registers the
displayed callback URL with the IdP, and enters:

- the exact HTTPS issuer URL;
- client ID and write-only client secret;
- `client_secret_post` or `client_secret_basic` token authentication;
- the signed claim containing the user's email (`email`, or
  `preferred_username` for providers such as Microsoft Entra);
- one or more allowed email domains.

camelAI validates the provider's discovery document before activating the
connection. The client secret is encrypted using `INTEGRATION_SECRET_KEY` and is
never returned by an API.

Users start at `/sso/<org-slug>`. The authorization-code flow uses PKCE S256,
state, and nonce. Login transactions are single-use, expire after ten minutes,
and are stored strongly consistently in OrgDO. The callback validates the code,
ID token signature, issuer, audience, nonce, and state through `openid-client`,
then binds `(connection, issuer, subject)` to an existing camelAI user. Users
first sign up through normal authentication, join the organization, and start
confirmation from authenticated account settings. Users are never created or
linked by an asserted email alone. This prevents an org-controlled IdP from
impersonating or squatting another camelAI account.

SSO sessions:

- are restricted to the configured organization;
- expire after eight hours by default;
- retain an absolute expiry across workspace changes;
- are rejected immediately if the connection is disabled or changed, the
  allowed domain changes, the org loses enterprise status, or membership is
  removed;
- carry the same organization, connection version, and absolute expiry into
  private deployed-app sessions, which are revalidated on every request.

The private-app constraint propagation spans the main and dispatcher workers.
Deploy the dispatcher first, then the main worker, when releasing this feature;
the dispatcher intentionally rejects legacy unversioned private-app sessions.

Normal password/OAuth login remains available as a break-glass path. Mandatory
SSO enforcement and SCIM provisioning are intentionally separate future work.

## Supported protocols

The initial implementation supports standards-based OIDC. SAML is not parsed
in-house because safe XML signature validation requires a Worker-compatible,
signature-wrapping-resistant implementation. It can be added behind the same
org connection and session model after that implementation is selected and
validated under workerd.
