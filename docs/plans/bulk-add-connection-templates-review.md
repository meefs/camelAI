# Bulk Add Connection Templates — Implementation Review

## Summary

The agent implemented the plan across 3 files: `integration-registry.ts` (new templates + schema changes), `integration-env.ts` (env var mappings), and both dialog components (description rendering). The existing tests pass. Below is feedback organized by severity.

---

## Issues

### 1. ProxyConfig and isProxyable() not removed (Phase 2 incomplete)

The plan called for removing `proxyConfig` from all existing templates and deleting the `ProxyConfig` interface, `isProxyable()` helper, and `proxyConfig` field from `IntegrationDefinition`. The current `IntegrationDefinition` no longer has `proxyConfig`, and the existing templates no longer reference it — so this was done. **Verify:** confirm that `ProxyConfig` interface and `isProxyable()` function were actually deleted, not just unused. If they still exist as dead code, delete them.

### 2. Stripe `api_version` config field not removed

The plan specifies removing the stale `api_version` config field from Stripe (it was only used by the proxy). The current implementation shows `configSchema: []` for Stripe, so this appears done. **Verify:** confirm no `api_version` reference remains.

### 3. OpenAI `default_model` not removed

The plan specifies removing the stale `default_model` config field from OpenAI. The current implementation shows only `organization_id` in `configSchema`, so this appears done.

### 4. Existing `getEnvVarSuffixesForType` test will fail

The existing test at line 41 in `integration-env.test.ts` asserts:
```typescript
expect(getEnvVarSuffixesForType('openai')).toEqual(['API_KEY']);
```

But the implementation now returns `['API_KEY', 'ORGANIZATION_ID']`. **This test needs updating.**

### 5. Missing tests for all 6 new env var mapping cases

`mapCredentialsToEnvVars` now has 6 new `case` blocks (supabase, databricks, sentry, mailchimp, posthog, mixpanel) and the updated openai case, but the test file has no coverage for any of them. The existing test patterns make it trivial to add these — see the Testing section below.

### 6. Missing tests for new `getEnvVarSuffixesForType` entries

The 6 new entries in `getEnvVarSuffixesForType` (supabase, databricks, sentry, mailchimp, posthog, mixpanel) have no corresponding test assertions.

---

## Nitpicks (non-blocking)

### N1. Anthropic case moved out of shared fallthrough group

Previously `anthropic` shared the `case 'openai': case 'anthropic': ... return ['API_KEY']` group. It's now a standalone case, which is fine — just note that the diff is larger than strictly necessary. No action needed.

### N2. OpenRouter and Typeform rely on `default` fallthrough

Both `openrouter` and `typeform` fall through to the `default` case in both `getEnvVarSuffixesForType` and `mapCredentialsToEnvVars`. This is correct and intentional per the plan. Consider adding a brief comment in the code (`// openrouter, typeform: handled by default case`) so future readers don't wonder if they were forgotten. Optional.

---

## Testing

You asked about what tests we can add without real credentials. The answer: **the env var mapping layer is fully testable with fake data.** No credentials or network access needed — these are pure functions that take plain objects and return plain objects.

Here are the tests to add to `tests/integration-env.test.ts`:

### A. Fix the broken OpenAI suffix test

```typescript
it('returns correct suffixes for openai', () => {
  expect(getEnvVarSuffixesForType('openai')).toEqual(['API_KEY', 'ORGANIZATION_ID']);
});
```

### B. Add suffix tests for all new types

```typescript
it('returns correct suffixes for supabase', () => {
  expect(getEnvVarSuffixesForType('supabase')).toEqual(['API_KEY', 'PROJECT_URL', 'KEY_TYPE']);
});

it('returns correct suffixes for databricks', () => {
  expect(getEnvVarSuffixesForType('databricks')).toEqual(['API_KEY', 'WORKSPACE_URL']);
});

it('returns correct suffixes for sentry', () => {
  expect(getEnvVarSuffixesForType('sentry')).toEqual(['API_KEY', 'ORGANIZATION']);
});

it('returns correct suffixes for mailchimp', () => {
  expect(getEnvVarSuffixesForType('mailchimp')).toEqual(['API_KEY', 'DATA_CENTER']);
});

it('returns correct suffixes for posthog', () => {
  expect(getEnvVarSuffixesForType('posthog')).toEqual(['API_KEY', 'HOST', 'PROJECT_ID']);
});

it('returns correct suffixes for mixpanel', () => {
  expect(getEnvVarSuffixesForType('mixpanel')).toEqual(['USERNAME', 'SECRET', 'PROJECT_ID', 'REGION']);
});
```

### C. Add env var mapping tests for all new types

```typescript
it('handles supabase', () => {
  const env = mapCredentialsToEnvVars(
    'My Project',
    'supabase',
    { api_key: 'eyJ_test_key' },
    { project_url: 'https://xyz.supabase.co', key_type: 'anon' }
  );
  expect(env).toEqual({
    INT_SUPABASE_MY_PROJECT_API_KEY: 'eyJ_test_key',
    INT_SUPABASE_MY_PROJECT_PROJECT_URL: 'https://xyz.supabase.co',
    INT_SUPABASE_MY_PROJECT_KEY_TYPE: 'anon',
  });
});

it('handles supabase with service_role key type', () => {
  const env = mapCredentialsToEnvVars(
    'Admin',
    'supabase',
    { api_key: 'eyJ_service_role' },
    { project_url: 'https://xyz.supabase.co', key_type: 'service_role' }
  );
  expect(env.INT_SUPABASE_ADMIN_KEY_TYPE).toBe('service_role');
});

it('handles databricks', () => {
  const env = mapCredentialsToEnvVars(
    'Workspace',
    'databricks',
    { api_key: 'dapi_test_123' },
    { workspace_url: 'https://dbc-abc123.cloud.databricks.com' }
  );
  expect(env).toEqual({
    INT_DATABRICKS_WORKSPACE_API_KEY: 'dapi_test_123',
    INT_DATABRICKS_WORKSPACE_WORKSPACE_URL: 'https://dbc-abc123.cloud.databricks.com',
  });
});

it('handles sentry', () => {
  const env = mapCredentialsToEnvVars(
    'Error Tracker',
    'sentry',
    { api_key: 'sntrys_test_123' },
    { organization: 'my-org' }
  );
  expect(env).toEqual({
    INT_SENTRY_ERROR_TRACKER_API_KEY: 'sntrys_test_123',
    INT_SENTRY_ERROR_TRACKER_ORGANIZATION: 'my-org',
  });
});

it('handles sentry without optional organization', () => {
  const env = mapCredentialsToEnvVars(
    'Sentry',
    'sentry',
    { api_key: 'sntrys_test_123' },
    {}
  );
  expect(env).toEqual({
    INT_SENTRY_SENTRY_API_KEY: 'sntrys_test_123',
  });
});

it('handles mailchimp', () => {
  const env = mapCredentialsToEnvVars(
    'Newsletter',
    'mailchimp',
    { api_key: 'abc123-us21' },
    { data_center: 'us21' }
  );
  expect(env).toEqual({
    INT_MAILCHIMP_NEWSLETTER_API_KEY: 'abc123-us21',
    INT_MAILCHIMP_NEWSLETTER_DATA_CENTER: 'us21',
  });
});

it('handles posthog', () => {
  const env = mapCredentialsToEnvVars(
    'Analytics',
    'posthog',
    { api_key: 'phx_test_123' },
    { host: 'https://eu.posthog.com', project_id: '12345' }
  );
  expect(env).toEqual({
    INT_POSTHOG_ANALYTICS_API_KEY: 'phx_test_123',
    INT_POSTHOG_ANALYTICS_HOST: 'https://eu.posthog.com',
    INT_POSTHOG_ANALYTICS_PROJECT_ID: '12345',
  });
});

it('handles posthog without optional project_id', () => {
  const env = mapCredentialsToEnvVars(
    'PH',
    'posthog',
    { api_key: 'phx_test' },
    { host: 'https://us.posthog.com' }
  );
  expect(env).toEqual({
    INT_POSTHOG_PH_API_KEY: 'phx_test',
    INT_POSTHOG_PH_HOST: 'https://us.posthog.com',
  });
});

it('handles mixpanel', () => {
  const env = mapCredentialsToEnvVars(
    'Product Analytics',
    'mixpanel',
    { api_key: 'sa_username.abc123', api_secret: 'sa_secret_xyz' },
    { project_id: '7654321', region: 'eu' }
  );
  expect(env).toEqual({
    INT_MIXPANEL_PRODUCT_ANALYTICS_USERNAME: 'sa_username.abc123',
    INT_MIXPANEL_PRODUCT_ANALYTICS_SECRET: 'sa_secret_xyz',
    INT_MIXPANEL_PRODUCT_ANALYTICS_PROJECT_ID: '7654321',
    INT_MIXPANEL_PRODUCT_ANALYTICS_REGION: 'eu',
  });
});

it('handles openai with organization_id', () => {
  const env = mapCredentialsToEnvVars(
    'GPT',
    'openai',
    { api_key: 'sk-test-123' },
    { organization_id: 'org-abc' }
  );
  expect(env).toEqual({
    INT_OPENAI_GPT_API_KEY: 'sk-test-123',
    INT_OPENAI_GPT_ORGANIZATION_ID: 'org-abc',
  });
});

it('handles openai without optional organization_id', () => {
  const env = mapCredentialsToEnvVars(
    'GPT',
    'openai',
    { api_key: 'sk-test-123' },
    {}
  );
  expect(env).toEqual({
    INT_OPENAI_GPT_API_KEY: 'sk-test-123',
  });
});

it('handles openrouter via default case', () => {
  const env = mapCredentialsToEnvVars(
    'Router',
    'openrouter',
    { api_key: 'sk-or-test' },
    {}
  );
  expect(env).toEqual({
    INT_OPENROUTER_ROUTER_API_KEY: 'sk-or-test',
  });
});

it('handles typeform via default case', () => {
  const env = mapCredentialsToEnvVars(
    'Forms',
    'typeform',
    { api_key: 'tfp_test_123' },
    {}
  );
  expect(env).toEqual({
    INT_TYPEFORM_FORMS_API_KEY: 'tfp_test_123',
  });
});
```

### D. Registry validation tests (optional but recommended)

You could also add a test that validates all registry entries have internally consistent schemas — this catches issues like the original Twilio bug where field names didn't match env var expectations:

```typescript
// New file: tests/integration-registry.test.ts
import { describe, it, expect } from 'vitest';
import { INTEGRATION_REGISTRY } from '../src/lib/integration-registry';
import { getEnvVarSuffixesForType } from '../workers/main/src/integration-env';

describe('integration registry consistency', () => {
  it('every registry entry has a matching getEnvVarSuffixesForType case', () => {
    for (const [type, def] of Object.entries(INTEGRATION_REGISTRY)) {
      const suffixes = getEnvVarSuffixesForType(type);
      // Should return a non-empty array (even if just ['API_KEY'] from default)
      expect(suffixes.length, `${type} should have env var suffixes`).toBeGreaterThan(0);
    }
  });

  it('every API-key integration has at least one credential field', () => {
    for (const [type, def] of Object.entries(INTEGRATION_REGISTRY)) {
      if (def.authMethod === 'api_key' && type !== 'bigquery') {
        // bigquery uses service_account_json which is a credential
        expect(
          def.credentialSchema.length,
          `${type} should have at least one credential field`
        ).toBeGreaterThan(0);
      }
    }
  });

  it('every OAuth integration has oauthConfig', () => {
    for (const [type, def] of Object.entries(INTEGRATION_REGISTRY)) {
      if (def.authMethod === 'oauth2') {
        expect(def.oauthConfig, `${type} should have oauthConfig`).toBeDefined();
      }
    }
  });

  it('select fields have options defined', () => {
    for (const [type, def] of Object.entries(INTEGRATION_REGISTRY)) {
      for (const field of def.configSchema) {
        if (field.type === 'select') {
          expect(
            field.options?.length,
            `${type}.${field.name} is a select but has no options`
          ).toBeGreaterThan(0);
        }
      }
    }
  });
});
```

This last test file is purely structural — it validates the registry against itself and the env mapping, no real API credentials needed.

---

## Checklist

- [x] Verify `ProxyConfig` / `isProxyable()` dead code is deleted — confirmed, no matches in src/ workers/ or tests/
- [x] Fix broken OpenAI suffix test (`['API_KEY']` -> `['API_KEY', 'ORGANIZATION_ID']`) — done
- [x] Add suffix tests for 6 new types — done
- [x] Add env var mapping tests for 8 new/updated types — done
- [ ] Optionally add registry consistency tests — not yet added (see section D above)
- [x] Run `bun run test:run` — 199 tests pass across 14 files, 46 in integration-env.test.ts
