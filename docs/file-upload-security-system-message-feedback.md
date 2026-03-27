# File Upload Security System Message — Implementation Feedback

## Summary

The implementation is clean and correct. The three changed files (`file-safety.ts`, `durable-objects.ts`, `control-plane.mjs`) match the plan well, and the test suite covers the important cases. All 13 tests pass. Feedback below is mostly minor.

---

## Must Fix

### 1. `splitFilename` has a dead code branch (file-safety.ts:80-85)

The `if (lastDot === 0)` block checks for `nextDot` but that branch can never be reached. When `lastDot === 0`, the filename is `.something` with exactly one dot — `indexOf('.', 1)` will always return `-1`, so the early return always fires and the fall-through after line 85 is dead code.

Not a bug (behavior is correct), but dead code in a security-adjacent module is confusing for future readers. Simplify to:

```typescript
if (lastDot === 0) {
  return { stem: '', extension: filename.toLowerCase() };
}
```

### 2. Plain `.env` upload has an empty stem after suffix stripping (file-safety.ts:93-98)

When `.env` is uploaded, the upload API generates `-1710000000-abc123.env` (empty sanitized basename becomes empty string, so the stored name starts with `-`). In `splitFilename`, `stem` = `-1710000000-abc123`. After `normalizeUnsafePatternStem` strips the stored suffix, the result is `""` (empty), so the filename pattern check returns `false`.

This is **not a bug** because `.env` is not in `SAFE_FILE_EXTENSIONS`, so the file is still caught as unsafe by the extension check. But it means the filename-pattern override for `.env*` doesn't actually fire for a plain `.env` upload — it relies on `.env` not being in the allowlist as a coincidence. Worth adding a comment noting this, or adding `.env` extension check explicitly.

---

## Should Fix

### 3. The `compose` pattern is too narrow

The pattern `/^compose$/i` only matches the exact stem `compose` (after suffix stripping). This correctly catches `compose.yaml` and `compose.yml`. But it won't catch `compose-prod.yaml` or `compose.override.yml` since those would have stems like `compose-prod` or `compose_override` after sanitization. Consider changing to `/^compose(?:[._-].*)?$/i` to match the same pattern used for the other overrides (dockerfile, docker-compose, makefile, env).

### 4. Missing test: safe-only uploads remain unmodified for email ingress format

The tests all use the `(user uploaded file to /mnt/user-uploads/...)` format which is correct. But there's no test for the `externalMessage` path specifically. Since `externalMessage` in `durable-objects.ts` now calls `injectFileSafetyMessage` on `rawMessage` directly, and email ingress builds message content in the same `(user uploaded file to ...)` format, the unit tests on `injectFileSafetyMessage` do cover this implicitly. But a brief comment in the test file noting that the same function covers both paths would help future readers.

---

## Nits

### 5. `_env` normalization is clever but not obvious

`normalizeUnsafePatternStem` converts a leading `.` to `_` (line 96-97) to handle the upload API's `.env` → `_env` sanitization (`baseName.replace(/[^a-zA-Z0-9_-]/g, '_')`). This is correct but non-obvious. A short comment explaining *why* the leading dot becomes `_` (because the upload API sanitizes it) would help future readers.

### 6. AGENTS.md bullet 12 is long

The new AGENTS.md entry (line 12) packs a lot of detail into one sentence. Consider splitting it into two: one for the file-safety system message injection, one for the filename-pattern overrides.

---

## Looks Good

- **Injection points are correct.** Both `handleChatMessage` (web chat) and `externalMessage` (email/Slack RPC) call `injectFileSafetyMessage` before `formatAttributedUserMessage`, so the system message flows through the existing pipeline correctly.
- **Allowlist coverage is comprehensive.** Images, data formats, documents, spreadsheets, fonts, and CSS all make sense as safe types.
- **Prohibited activities section** is well-placed after `</core_constraints>` and uses appropriately strong language. The scope preamble ("these apply everywhere: the sandbox container, deployed Cloudflare Worker apps, and any other context") is clear.
- **Test coverage is solid.** Extension checks, case insensitivity, mixed safe/unsafe, extensionless files, multi-dot filenames, existing system messages, and all filename-pattern overrides are tested.
- **The `STORED_UPLOAD_SUFFIX_REGEX`** correctly strips the `-{timestamp}-{random}` suffix added by the upload API, letting filename patterns match against the original stem. Good attention to how the upload API transforms names.
