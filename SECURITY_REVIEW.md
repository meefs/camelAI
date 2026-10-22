# Security hardening review — 2026-10-22

Scope: source review from `origin/main` at `e915d565c`, dependency audit,
local regression tests, production build, and a Chromium security smoke.
This is a bounded review, not a penetration test or a security certification.

## Changes

- All five authenticated raw-file routes now apply a shared response policy:
  CSP sandbox without `allow-same-origin`, `nosniff`, no referrer, and escaped
  download filenames. This covers HTML, SVG, XML/XHTML and untrusted R2 MIME
  metadata. Scripts remain usable in previews, but cannot read the parent app,
  its origin storage, or authenticated API responses. The CSP applies when a
  file is opened directly, independently of iframe attributes.
- The main Worker rejects cross-origin mutations before handing requests to
  React Router. It treats sibling user-app origins as untrusted. Cookie writes
  without source metadata fail closed; same-origin forms and explicit-token
  non-browser clients remain supported. Worker-native webhooks/MCP retain their
  existing authentication before this boundary.
- Login, signup, auth-layout, and OAuth redirects share browser-compatible URL
  validation, rejecting backslash/control-character and normalized `//` bypasses.
- Updated React Router, Conform, Hono, Vite, Vitest and Sharp. Transitive security
  overrides pin patched compatible release lines, including MCP SDK, URI/IP
  parsers, HTTP clients and CSS tooling. Review these overrides when upgrading
  their parents; do not remove them while the resolved version is vulnerable.
- The standalone renderer has an explicit source alias so its build continues
  to resolve shared UI modules with the updated Vite version.

## Validation

- App suite: 2,695 passed, 6 skipped (330 files passed, 1 skipped).
- Full Worker suite: 1,924 passed, 39 skipped (180 files passed, 32 skipped).
- Focused Worker auth/OAuth/MCP/fetch suite: 63 passed; Discord bridge: 36 passed.
- Typecheck, lint, production build and Pi Bedrock bundle check passed.
- Chromium: an inline untrusted HTML document has origin `null`; parent DOM and
  local storage reads throw, and a credentialed write is rejected with HTTP 403.
- `bun audit --json`: 91 advisory entries across 26 packages before; 2 entries
  in one package after. Counts include transitive and development dependencies
  and do not establish that every advisory was exploitable in production.

## Remaining work / limits

- `extract-zip@2.0.1` has two high-severity symlink traversal advisories, with no
  patched release in the registry at review time. It comes from
  `@cloudflare/puppeteer -> @puppeteer/browsers`. The Cloudflare remote-browser
  entrypoint does not use the Node browser installer, and the production build
  contains neither `extract-zip` nor `unpackArchive`. Avoid using that installer
  on untrusted archives; track upstream removal/replacement. This is an
  outstanding dependency finding, not a clean audit.
- The password-login route has no application-level attempt throttle visible
  in the reviewed path. Verify deployed WAF/rate-limit coverage and add a
  coordinated per-IP/per-account limit without enabling account-lockout abuse.
- This pass did not audit live Cloudflare IAM, WAF rules, secret rotation,
  database egress ACLs, tenant-isolation behavior of the external agent runtime,
  or all connectors. Those require separate live validation.
- The opaque-origin file policy intentionally prevents previews from accessing
  the application session/storage. Cookie-authenticated API clients that omit
  Origin, Referer and Fetch Metadata must send their legitimate Origin or move
  to explicit token authentication.

## Deeper OAuth follow-up

Reviewed sign-in, integration callbacks, remote MCP OAuth, and admin MCP OAuth.
Additional fixes:

- Google sign-in requires `verified_email === true`; GitHub always obtains the
  address from its authenticated verified-email list, including public profiles.
- Stable provider subjects take precedence over mutable email matches. Existing
  unverified password accounts cannot be implicitly linked, deleted identities
  are not silently recreated, and conflicting provider links fail atomically in
  UserDO. This closes account-confusion and password pre-registration paths.
- Google/GitHub authorization requests use S256 PKCE. The verifier is held in the
  signed HttpOnly state cookie and required at callback/token exchange.
- Integration callbacks require the signed-in user that initiated the flow,
  explicitly enforce five-minute state expiry, and consume state through an
  atomic UserDO SQLite latch. KV deletion alone is no longer the replay barrier.
- Admin MCP code redemption and refresh rotation use the same atomic latch;
  replay fingerprints are hashed, expired records are rejected independently of
  KV expiry, and code creation requires a valid S256 challenge. Redirects reject
  credentials, fragments, backslashes and control/whitespace characters.
- Remote MCP discovery requires matching authorization-server issuer metadata.
  Discovery, registration, exchange and refresh requests revalidate endpoints,
  reject redirects, time out after 15 seconds, and bound bodies to 1 MiB.
  Provider error bodies are not copied into token/registration errors. Sign-in
  provider requests also reject redirects and omit raw token error responses.

Regression coverage includes stale KV reads, concurrent callback/code/refresh
replay, concurrent provider replacement, mismatched browser users, unverified
emails, password pre-registration, PKCE, issuer substitution, private endpoints,
credential-bearing redirects, and oversized OAuth responses.

Compatibility: a sign-in started before this release must be restarted to get
its PKCE verifier. Integration callbacks after logout or an account switch fail
closed. Providers must publish issuer metadata correctly and expose OAuth
endpoints directly rather than redirecting token/registration requests.

Additional follow-up: OAuth first-account provisioning still writes email and
provider indexes in KV; coordinate it with password signup's SignupDO before
claiming race-free account provisioning. The changes above protect linked
identity selection, but do not replace the entire account-index architecture.
A live end-to-end login/consent run against every external provider and review of
remote MCP DNS/egress enforcement remain outside the local regression evidence.
Protocol reference: https://www.rfc-editor.org/rfc/rfc9700.html

Follow-up validation: 2,703 app tests, 1,940 Worker tests, and 36 Discord bridge
 tests passed (existing skips retained). Focused OAuth regressions passed,
including a final linked-identity revocation check. Typecheck, lint, production
build and the Pi Bedrock bundle check passed. Live provider consent is not
covered by these local tests.
