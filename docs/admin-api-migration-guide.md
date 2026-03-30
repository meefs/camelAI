# Admin API Migration Guide for Dashboard

This guide maps what you originally requested to what was actually built, and tells you exactly how to use each endpoint.

## What Was Requested vs. What Was Built

| # | Your Request | Status | Notes |
|---|---|---|---|
| 1 | `GET /spam/org-ids` | Built | Exact match to your spec |
| 2 | `GET /dashboard/summary` | Built | Backend now returns the dashboard summary payload directly |
| 3 | `GET /dashboard/retention` | Built | Backend now returns the retention payload directly |
| 4 | `GET /dashboard/top-orgs` | Built | Exact match to your spec with minor field naming differences |
| 5 | `GET /dashboard/spam-summary` | Built | Exact match to your spec with minor field naming differences |
| 6 | `GET /orgs/:id` | Already existed | Was already a direct lookup, no changes needed |
| 7 | `GET /orgs` (filters) | Built | All requested query params added |

## Auth

All endpoints use Bearer token auth:

```
Authorization: Bearer <ADMIN_API_KEY>
```

Base path: `/api/admin`

---

## 1. `GET /api/admin/spam/org-ids`

Replaces your 658 individual `/orgs/{id}/usage/limits` calls.

**Request:**

```
GET /api/admin/spam/org-ids
```

No query params.

**Response:**

```json
{
  "org_ids": ["uuid-1", "uuid-2"],
  "count": 2
}
```

This is an exact match to what you requested. Spam = org where every effective spend window has `limit_usd <= 0.01`.

---

## 2. `GET /api/admin/dashboard/summary`

This endpoint is now live.

**Request:**

```http
GET /api/admin/dashboard/summary
GET /api/admin/dashboard/summary?date=2026-03-30
GET /api/admin/dashboard/summary?date=2026-03-30&exclude_spam=false&exclude_internal_domains=camelai.com,example.com
```

**Query params:**

| Param | Default | Notes |
|---|---|---|
| `date` | current UTC day | `YYYY-MM-DD` drill-down date |
| `exclude_spam` | `true` (implicit) | `true`, `false` |
| `exclude_internal_domains` | `camelai.com` | Comma-separated domain list |

**Response sections:**

- `kpis`
- `daily_series`
- `weekly_series`
- `growth_thresholds`
- `selected_day`
- `billing_breakdown`
- `app_visibility`
- `retention_snapshot`

---

## 3. `GET /api/admin/dashboard/retention`

This endpoint is now live.

**Request:**

```http
GET /api/admin/dashboard/retention
GET /api/admin/dashboard/retention?exclude_spam=false&exclude_internal_domains=camelai.com,example.com
```

**Query params:**

| Param | Default | Notes |
|---|---|---|
| `exclude_spam` | `true` (implicit) | `true`, `false` |
| `exclude_internal_domains` | `camelai.com` | Comma-separated domain list |

**Response sections:**

- `cohort_table`
- `max_week_columns`
- `retention_curve`
- `wau_time_series`
- `stickiness_series`
- `kpis`

---

## 4. `GET /api/admin/dashboard/top-orgs`

Replaces your ~60 per-org usage/spend calls.

**Request:**

```
GET /api/admin/dashboard/top-orgs
GET /api/admin/dashboard/top-orgs?limit=25&exclude_spam=true&sort_by=spend_7d
```

**Query params:**

| Param | Default | Options |
|---|---|---|
| `limit` | `25` | `1`–`100` |
| `exclude_spam` | `true` (implicit) | `true`, `false` |
| `exclude_internal_domains` | `camelai.com` | Comma-separated domain list |
| `sort_by` | `spend_7d` | `spend_7d`, `spend_30d`, `member_count` |

**Response:**

```json
{
  "items": [
    {
      "org_id": "uuid",
      "name": "Acme Corp",
      "slug": "acme",
      "created_at": 1710000000000,
      "created_by": "user_123",
      "creator_name": "Jane Doe",
      "creator_email": "founder@acme.com",
      "member_count": 12,
      "workspace_count": 3,
      "billing_status": "active",
      "total_requests": 1500,
      "total_cost_usd": 42.50,
      "spend_7d": 20.00,
      "spend_30d": 38.20,
      "windows": [
        {
          "label": "5h",
          "window_ms": 18000000,
          "limit_usd": 50.00,
          "spent_usd": 2.30,
          "exceeded": false
        }
      ]
    }
  ],
  "count": 1,
  "limit": 25,
  "sort_by": "spend_7d"
}
```

**Differences from your original spec:**

- Response uses `items` array, not `orgs`
- Field is `org_id`, not `id`
- Includes `spend_7d` (your spec only had `spend_30d`)
- `billing_status` normalizes `paying` to `active` at the API boundary
- `windows` uses `window_ms` (milliseconds) instead of plain label strings

---

## 5. `GET /api/admin/dashboard/spam-summary`

Replaces all spam tab data fetching.

**Request:**

```
GET /api/admin/dashboard/spam-summary
```

No query params. Only fetch this when the user navigates to the spam tab.

**Response:**

```json
{
  "users": [
    {
      "id": "user_123",
      "email": "user@example.com",
      "name": "User Example",
      "avatar": { "color": "#666", "content": "U" },
      "created_at": 1710000000000,
      "org_count": 2,
      "is_superuser": false,
      "is_orphaned": false
    }
  ],
  "threads": [
    {
      "id": "thread_123",
      "title": "Spam Thread",
      "workspace_id": "ws_123",
      "created_at": 1710000000000,
      "updated_at": 1710000000000,
      "created_by": "user_123",
      "org_id": "org_123",
      "org_name": "Spam Org",
      "workspace_name": "Default Workspace"
    }
  ],
  "apps": [
    {
      "app_id": "org_123:spam-app",
      "script_name": "spam-app",
      "org_id": "org_123",
      "workspace_id": "ws_123",
      "org_name": "Spam Org",
      "org_slug": "spam01",
      "workspace_name": "Default Workspace",
      "created_by": "user_123",
      "created_by_name": "User Example",
      "created_by_email": "user@example.com",
      "created_at": 1710000000000,
      "updated_at": 1710000000000,
      "is_public": true,
      "preview_status": "pending",
      "preview_error": null
    }
  ],
  "orgs": [
    {
      "id": "org_123",
      "name": "Spam Org",
      "slug": "spam01",
      "created_by": "user_123",
      "created_at": 1710000000000,
      "archived": false,
      "billing_status": "active",
      "member_count": 2,
      "workspace_count": 1
    }
  ],
  "org_usage": [
    {
      "org_id": "org_123",
      "name": "Spam Org",
      "slug": "spam01",
      "created_at": 1710000000000,
      "created_by": "user_123",
      "creator_name": "User Example",
      "creator_email": "user@example.com",
      "member_count": 2,
      "workspace_count": 1,
      "billing_status": "active",
      "total_requests": 9,
      "total_cost_usd": 18.5,
      "spend_7d": 7.5,
      "spend_30d": 15.25,
      "windows": []
    }
  ]
}
```

**Differences from your original spec:**

- `users` does not include `thread_count` or `app_count` per user. It includes `org_count`, `is_superuser`, `is_orphaned` instead.
- `users` includes any user who is a member of a spam org, even if they also belong to non-spam orgs. This is intentional for investigation.
- `threads` uses the standard admin thread shape (includes `org_id`, `workspace_id`, `org_name`, `workspace_name`) rather than denormalized `created_by_name`/`created_by_email`.
- `apps` uses `app_id` and `script_name` (not `scriptName`), with full join fields.
- `org_usage` uses the same shape as `/dashboard/top-orgs` items (keyed by `org_id`, not `id`).
- `billing_status` normalizes `paying` to `active`.
- Sorted: `org_usage` by `spend_30d` desc; all other arrays by `created_at` desc.

---

## 6. `GET /api/admin/orgs/:id` — ALREADY EXISTED

This was already a direct primary-key lookup. No changes were needed. Your `fetchOrgById()` can call this directly instead of paginating through all orgs.

**Request:**

```
GET /api/admin/orgs/org_123
```

**Response:** Single org object with `threads`, `apps`, `threadCount`, `appCount`.

---

## 7. `GET /api/admin/orgs` — UPDATED WITH NEW FILTERS

**New query params (all optional, additive to existing params):**

| Param | Default | Description |
|---|---|---|
| `exclude_spam` | not set (opt-in) | Exclude spam org IDs |
| `exclude_internal_domains` | not set (opt-in) | Comma-separated domains to exclude by creator email |
| `include_usage` | not set | Include `total_requests`, `total_cost_usd`, `windows` per org |
| `include_spend_30d` | not set | Include `spend_30d` per org |
| `search` | — | Now matches both `name` AND `slug` (previously name only) |

**Important:** Unlike `/dashboard/top-orgs`, this endpoint does **not** default to filtering by `camelai.com` or excluding spam. Filtering is opt-in here to preserve backward compatibility.

**Example — search with usage enrichment:**

```
GET /api/admin/orgs?search=acme&include_usage=true&include_spend_30d=true
```

**Response (standard paginated list):**

```json
{
  "items": [
    {
      "id": "org_123",
      "name": "Acme Corp",
      "slug": "acme",
      "created_by": "user_123",
      "created_at": 1710000000000,
      "archived": false,
      "billing_status": "paying",
      "member_count": 12,
      "workspace_count": 3,
      "total_requests": 1500,
      "total_cost_usd": 42.50,
      "spend_30d": 38.20,
      "windows": [
        {
          "label": "5h",
          "window_ms": 18000000,
          "limit_usd": 50.00,
          "spent_usd": 2.30,
          "exceeded": false
        }
      ]
    }
  ],
  "total": 1,
  "offset": 0,
  "limit": 50
}
```

**Note:** `billing_status` is returned as-is (`paying`/`free`) on this endpoint, not normalized to `active`/`free` like the dashboard endpoints. This is intentional for backward compatibility. The additive fields (`total_requests`, `total_cost_usd`, `spend_30d`, `windows`) only appear when their respective `include_*` param is set.

---

## Migration Checklist

For the dashboard agent updating the client:

1. Replace all per-org `/orgs/{id}/usage/limits` fan-out with a single `GET /api/admin/spam/org-ids` call
2. Replace `fetchOrgById()` pagination-then-filter with direct `GET /api/admin/orgs/:id`
3. Replace client-side org search (fetch all, filter in JS) with `GET /api/admin/orgs?search=...`
4. Replace per-org usage enrichment calls with `GET /api/admin/orgs?include_usage=true&include_spend_30d=true`
5. Replace top-orgs fan-out (30 spend calls + 30 sum calls) with `GET /api/admin/dashboard/top-orgs`
6. Replace spam tab prefetch + per-org usage calls with `GET /api/admin/dashboard/spam-summary`
7. Replace the remaining client-side summary/retention computation with `GET /api/admin/dashboard/summary` and `GET /api/admin/dashboard/retention`.

## Full API Reference

See [docs/admin-api-reference.md](admin-api-reference.md) for complete endpoint documentation including all request/response schemas.
