# New Branding Logo Update Plan

Created: June 5, 2026

This plan is intended to be handed directly to a coding agent for implementation.
It covers the three camelAI codebases that need the June 2026 logo refresh:

- `/Users/illiana/Projects/camelai-salessite` - sales site, `camelai.com`
- `/Users/illiana/Projects/chiridion-app` - main app, `camelai.dev`
- `/Users/illiana/Projects/docs` - docs site

## Goal

Replace the old camelAI logo and favicon assets with the new June 2026 branding
assets, regenerate all favicon/icon variants, and verify there are no obvious old
brand surfaces left in these three codebases.

Use this source directory:

```bash
BRAND_DIR="/Users/illiana/Desktop/camelAI-new-branding/NEW-BRANDING-06-2026"
```

Use this exact source SVG as the new favicon source wherever a favicon SVG is
used:

```bash
"$BRAND_DIR/qwaml-box light-mode.svg"
```

## Source Asset Map

The new branding directory contains these relevant files:

| Source file | Size | Intended use |
| --- | ---: | --- |
| `camelAI-fullname-logo-lightmode.svg` | 1932 x 466 | Full wordmark for light UI backgrounds, black text |
| `camelAI-fullname-logo-darkmode.svg` | 1932 x 466 | Full wordmark for dark UI backgrounds, white text |
| `camelAI-fullname-logo-lightmode.png` | 1932 x 466 | Raster full wordmark for email/docs or places requiring PNG |
| `camelAI-fullname-logo-darkmode.png` | 1932 x 466 | Raster dark-mode full wordmark for docs or places requiring PNG |
| `qwaml-box light-mode.svg` | 466 x 466 | New favicon source, black square with white mark |
| `qwaml-box light-mode.png` | 466 x 466 | PNG source for docs favicon if using `sips` resize |
| `qwaml-box dark-mode.svg` | 466 x 466 | Optional dark-mode boxed icon if a theme-specific square icon is needed |
| `qwaml-black.svg` | 358 x 400 | Optional unboxed black mark |
| `qwaml-white.svg` | 358 x 400 | Optional unboxed white mark |

Keep target filenames stable in each repo unless the implementation has a strong
reason to change them. Stable paths reduce code churn and avoid updating every
consumer.

## Audit Summary

### Main App, `/Users/illiana/Projects/chiridion-app`

Current brand assets and references:

| Path | Current role | Required change |
| --- | --- | --- |
| `public/favicon.svg` | Source SVG for generated favicon variants | Replace with `qwaml-box light-mode.svg` |
| `public/favicon-16x16.png` | Generated favicon | Regenerate |
| `public/favicon-32x32.png` | Generated favicon | Regenerate |
| `public/apple-touch-icon.png` | Generated iOS icon | Regenerate |
| `public/android-chrome-192x192.png` | Generated PWA icon | Regenerate |
| `public/android-chrome-512x512.png` | Generated PWA icon and maskable manifest icon | Regenerate |
| `public/favicon.ico` | Generated legacy ICO | Regenerate |
| `public/camelAI-fullname-logo-lightmode.svg` | Full logo used by `FullLogo` | Replace |
| `public/camelAI-fullname-logo-darkmode.svg` | Full logo used by `FullLogo` | Replace |
| `public/camelAI-fullname-logo-lightmode.png` | Email logo at `https://camelai.dev/camelAI-fullname-logo-lightmode.png` | Replace |
| `src/components/ui/logo.tsx` | `FullLogo` image references and inline old `LogoIcon` SVG | Replace inline old `LogoIcon` with new icon asset |
| `src/root.tsx` | Favicon, apple touch icon, manifest links | No path change expected |
| `public/site.webmanifest` | Android icon references | No path change expected |
| `src/lib/email/templates/help-confirmation-email.tsx` | Uses existing lightmode PNG URL | No URL change expected |
| `workers/dispatcher/src/error-pages.ts` | Links deployed app error pages to `${homeUrl}/favicon.svg` | No code change expected once main app favicon is updated |

Email template audit: `src/lib/email/templates/help-confirmation-email.tsx` is
the only current email template that embeds a camelAI logo. It points at
`https://camelai.dev/camelAI-fullname-logo-lightmode.png`, so replacing
`public/camelAI-fullname-logo-lightmode.png` updates the email logo without
changing template code or email snapshot expectations. The other current email
templates (`email-verification-email.tsx`, `help-support-email.tsx`, and
`org-invitation-email.tsx`) do not embed a logo.

Not in scope:

- `public/logos/*` integration and model logos. These are third-party logos, not
  camelAI branding.
- `sandbox/create-worker/templates/starter/*` logos and favicon unless product
  explicitly wants generated user starter apps to show camelAI branding. They
  are starter app template assets and not public camelAI surfaces.

### Sales Site, `/Users/illiana/Projects/camelai-salessite`

Current brand assets and references:

| Path | Current role | Required change |
| --- | --- | --- |
| `public/favicon.svg` | Source SVG for generated favicon variants | Replace with `qwaml-box light-mode.svg` |
| `public/favicon-16x16.png` | Generated favicon | Regenerate |
| `public/favicon-32x32.png` | Generated favicon | Regenerate |
| `public/apple-touch-icon.png` | Generated iOS icon | Regenerate |
| `public/android-chrome-192x192.png` | Generated PWA icon | Regenerate |
| `public/android-chrome-512x512.png` | Generated PWA icon and maskable manifest icon | Regenerate |
| `public/favicon.ico` | Generated legacy ICO | Regenerate |
| `public/logo-light.svg` | Navbar and JSON-LD logo for light mode | Replace with `camelAI-fullname-logo-lightmode.svg` |
| `public/logo-dark.svg` | Navbar, about page JSON-LD, and OG image generator logo | Replace with `camelAI-fullname-logo-darkmode.svg` |
| `app/root.tsx` | Favicon links and organization JSON-LD logo | No path change expected |
| `app/components/navbar.tsx` | Full logo images | No path change expected |
| `app/routes/about-us.tsx` | Organization JSON-LD logo | No path change expected |
| `public/site.webmanifest` | Android icon references | No path change expected |
| `scripts/generate-og-images.ts` | Draws `public/logo-dark.svg` into `public/og/*.png` | Regenerate OG images after logo replacement |
| `public/og/*.png` | Social preview images that include the logo | Regenerate |

The existing `scripts/generate-og-images.ts` hard-codes the logo dimensions as
1932 x 466, which matches the new full logo SVG dimensions. No sizing code
change is expected, but verify the top-left logo looks correct in at least one
regenerated OG image.

Not in scope:

- `public/logos/*` social/integration/vendor icons.

### Docs Site, `/Users/illiana/Projects/docs`

Current brand assets and references:

| Path | Current role | Required change |
| --- | --- | --- |
| `favicon.png` | Docs favicon, referenced by `docs.json` | Replace with generated 64 x 64 PNG from `qwaml-box light-mode` |
| `logo/light.png` | Docs light logo, referenced by `docs.json` | Replace with `camelAI-fullname-logo-lightmode.png` |
| `logo/dark.png` | Docs dark logo, referenced by `docs.json` | Replace with `camelAI-fullname-logo-darkmode.png` |
| `docs.json` | References `/favicon.png`, `/logo/light.png`, `/logo/dark.png` | No path change expected |

The docs repo does not currently have a favicon generation script. Keep the
existing `docs.json` paths and generate or resize the PNG assets in place.

## Implementation Steps

### 1. Preflight

For each repo, check the working tree before changing assets:

```bash
git -C /Users/illiana/Projects/chiridion-app status --short
git -C /Users/illiana/Projects/camelai-salessite status --short
git -C /Users/illiana/Projects/docs status --short
```

If there are unrelated user changes, do not revert them. Work around them or
call them out before committing.

### 2. Main App Asset Replacement

In `/Users/illiana/Projects/chiridion-app`:

```bash
BRAND_DIR="/Users/illiana/Desktop/camelAI-new-branding/NEW-BRANDING-06-2026"

cp "$BRAND_DIR/qwaml-box light-mode.svg" public/favicon.svg
cp "$BRAND_DIR/camelAI-fullname-logo-lightmode.svg" public/camelAI-fullname-logo-lightmode.svg
cp "$BRAND_DIR/camelAI-fullname-logo-darkmode.svg" public/camelAI-fullname-logo-darkmode.svg
cp "$BRAND_DIR/camelAI-fullname-logo-lightmode.png" public/camelAI-fullname-logo-lightmode.png
```

Regenerate all favicon/icon variants from the new `public/favicon.svg`:

```bash
bun scripts/generate-favicons.mjs
```

Then update `src/components/ui/logo.tsx`:

- Keep `FullLogo` pointed at the same full-logo SVG paths.
- Replace the inline old camel `LogoIcon` SVG with the new boxed icon asset.
- Prefer using the already-stable `/favicon.svg` path for `LogoIcon`, unless
  the implementer decides to add a separate `public/qwaml-box-light-mode.svg`
  asset for clarity.

Recommended `LogoIcon` shape:

```tsx
export function LogoIcon({ className }: LogoIconProps) {
  return (
    <img
      src="/favicon.svg"
      alt=""
      aria-hidden="true"
      className={cn("size-6", className)}
    />
  );
}
```

Rationale: the only audited use is `src/routes/invitations.$orgId.$invitationId.tsx`,
where the icon is adjacent to visible `camelAI` text, so a decorative image
avoids duplicate screen-reader output. If future use requires an accessible
standalone icon, add an optional `alt` prop instead of hard-coding text.

Do not change `src/root.tsx` or `public/site.webmanifest` unless regenerated
assets require a path change. The existing links already cover SVG favicon,
ICO, PNG favicons, Apple touch icon, and manifest.

### 3. Sales Site Asset Replacement

In `/Users/illiana/Projects/camelai-salessite`:

```bash
BRAND_DIR="/Users/illiana/Desktop/camelAI-new-branding/NEW-BRANDING-06-2026"

cp "$BRAND_DIR/qwaml-box light-mode.svg" public/favicon.svg
cp "$BRAND_DIR/camelAI-fullname-logo-lightmode.svg" public/logo-light.svg
cp "$BRAND_DIR/camelAI-fullname-logo-darkmode.svg" public/logo-dark.svg
```

Regenerate favicon/icon variants:

```bash
npm run generate-favicons
```

Regenerate social/OG images because they render `public/logo-dark.svg` into
`public/og/*.png`:

```bash
./node_modules/.bin/vite-node scripts/generate-og-images.ts
```

If the OG command fails because `vite-node` is unavailable, add an explicit
package script and direct dev dependency rather than leaving the command
undocumented. A reasonable follow-up patch is:

```json
{
  "scripts": {
    "generate-og-images": "vite-node scripts/generate-og-images.ts"
  }
}
```

Only add or adjust the dependency if local execution proves it is not already
available. The current checkout has `./node_modules/.bin/vite-node`.

Do not change `app/root.tsx`, `app/components/navbar.tsx`, or
`app/routes/about-us.tsx` unless a path changes. Their current references should
pick up the replaced assets.

### 4. Docs Site Asset Replacement

In `/Users/illiana/Projects/docs`:

```bash
BRAND_DIR="/Users/illiana/Desktop/camelAI-new-branding/NEW-BRANDING-06-2026"

cp "$BRAND_DIR/camelAI-fullname-logo-lightmode.png" logo/light.png
cp "$BRAND_DIR/camelAI-fullname-logo-darkmode.png" logo/dark.png
sips -z 64 64 "$BRAND_DIR/qwaml-box light-mode.png" --out favicon.png
```

If `sips` is unavailable, use `sharp` from either app repo to resize the source
PNG to 64 x 64. The target file must remain `favicon.png` because `docs.json`
already references that path.

Do not change `docs.json` unless the implementation intentionally changes asset
paths. The audited paths are already correct:

```json
"favicon": "/favicon.png",
"logo": {
  "light": "/logo/light.png",
  "dark": "/logo/dark.png"
}
```

## Verification

### Main App

Run these from `/Users/illiana/Projects/chiridion-app`:

```bash
file public/favicon.svg public/favicon.ico public/favicon-16x16.png public/favicon-32x32.png public/apple-touch-icon.png public/android-chrome-192x192.png public/android-chrome-512x512.png
rg -n "viewBox=\"0 0 147 215\"" src/components src/routes
rg -n "camel-new-favicon|qwaml-in-square|OLD-BRANDING|favicon-old" public src workers scripts
rg -n "camelAI-fullname-logo|<Img|logo" src/lib/email
bun run typecheck
bun run test:run tests/help-email-templates.test.ts tests/help-email-delivery.test.ts
```

Expected:

- `file` reports PNG dimensions of 16, 32, 180, 192, and 512 where applicable.
- The `viewBox="0 0 147 215"` search returns no results.
- The old-brand search returns no relevant app/surface references.
- The email-template search still shows only the intended hosted logo URL in
  `help-confirmation-email.tsx`.
- Typecheck passes.
- Help email tests pass and keep the same logo URL.

Manual spot checks:

- Login page and signup page show the new full logo in light and dark themes.
- Onboarding layout shows the new full logo.
- Invitation acceptance page shows the new boxed icon.
- Browser tab favicon shows the new boxed mark.
- PWA manifest still resolves `/android-chrome-192x192.png` and
  `/android-chrome-512x512.png`.

### Sales Site

Run these from `/Users/illiana/Projects/camelai-salessite`:

```bash
file public/favicon.svg public/favicon.ico public/favicon-16x16.png public/favicon-32x32.png public/apple-touch-icon.png public/android-chrome-192x192.png public/android-chrome-512x512.png
file public/logo-light.svg public/logo-dark.svg public/og/og-default.png
rg -n "camel-new-favicon|qwaml-in-square|OLD-BRANDING|favicon-old" public app scripts workers
npm run typecheck
npm run build
```

Expected:

- Favicon/icon dimensions match 16, 32, 180, 192, and 512 where applicable.
- `public/og/og-default.png` is regenerated after the logo swap.
- Typecheck and build pass.

Manual spot checks:

- Navbar logo shows the new wordmark in light and dark themes.
- Browser tab favicon shows the new boxed mark.
- At least `public/og/og-default.png` visually contains the new logo, correctly
  sized in the top-left.
- Organization JSON-LD still points to `/logo-light.svg`.

### Docs Site

Run these from `/Users/illiana/Projects/docs`:

```bash
file favicon.png logo/light.png logo/dark.png
npm run doctor
npm run build
```

Expected:

- `favicon.png` is 64 x 64.
- `logo/light.png` and `logo/dark.png` are the new full-logo PNGs.
- Docsflare doctor/build passes.

Manual spot checks:

- Docs navbar/sidebar logo shows the new wordmark in light and dark themes.
- Browser tab favicon shows the new boxed mark.

## Cache And Deployment Notes

- These updates intentionally keep public asset paths stable. That minimizes code
  changes, but favicons and static images are often cached aggressively by
  browsers and CDNs.
- After deploying, verify in a private browser window and with a hard refresh.
- If production continues to show old icons, purge the exact asset paths from
  Cloudflare cache:
  - `/favicon.svg`
  - `/favicon.ico`
  - `/favicon-16x16.png`
  - `/favicon-32x32.png`
  - `/apple-touch-icon.png`
  - `/android-chrome-192x192.png`
  - `/android-chrome-512x512.png`
  - `/logo-light.svg`
  - `/logo-dark.svg`
  - `/camelAI-fullname-logo-lightmode.svg`
  - `/camelAI-fullname-logo-darkmode.svg`
  - `/camelAI-fullname-logo-lightmode.png`
  - `/favicon.png`
  - `/logo/light.png`
  - `/logo/dark.png`

## Acceptance Criteria

- Main app, sales site, and docs all use the new June 2026 full logo.
- Main app, sales site, and docs all use `qwaml-box light-mode` as their favicon
  source or generated favicon.
- All existing favicon/icon variants are regenerated where the repo has them.
- Sales-site OG images are regenerated with the new logo.
- Main app no longer contains the old inline camel `LogoIcon` SVG.
- No third-party integration/social logos are accidentally modified.
- Relevant typecheck/build/doctor/test commands pass or any failures are
  documented with exact reasons.
