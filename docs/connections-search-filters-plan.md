# Connections Page: Search + Filters

**Date:** 2026-03-08
**File:** `src/components/pages/connections/connections-client.tsx`

---

## Objective

Make the `/connections` page searchable and add filters so users can quickly find specific connections in workspaces with many configured integrations.

## Current State

```
┌──────────────────────────────────────────────────────────────────┐
│ ☰ │ Connections                                                  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Connections                              [+ Add Connection]     │
│  Connect external services so your                               │
│  apps can read and write data.                                   │
│                                                                  │
│  ┌───────────────────────┐  ┌───────────────────────┐           │
│  │ 🐘 Postgres           │  │ 💳 Stripe              │           │
│  │    PostgreSQL          │  │    Stripe              │           │
│  │    Updated 3/1/26      │  │    Updated 2/15/26     │           │
│  │ [Configure] [Clone] 🗑│  │ [Configure] [Clone] 🗑│           │
│  └───────────────────────┘  └───────────────────────┘           │
│  ┌───────────────────────┐  ┌───────────────────────┐           │
│  │ 💬 Slack              │  │ 🤖 OpenAI              │           │
│  │    Slack               │  │    OpenAI              │           │
│  │    Updated 1/20/26     │  │    Updated 1/5/26      │           │
│  │ [Configure] [Clone] 🗑│  │ [Configure] [Clone] 🗑│           │
│  └───────────────────────┘  └───────────────────────┘           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

- No search on the main connections list
- No filtering by category or anything else
- Search + category tabs exist only inside the "Add Connection" picker dialog
- Cards are rendered in a 2-col grid, unordered

## Available Data for Filtering

Each `Integration` object has:
| Field | Type | Values |
|---|---|---|
| `name` | string | User-given name |
| `integration_type` | string | Registry key (e.g. `postgres`, `stripe`) |
| `category` | IntegrationCategory | `databases`, `saas`, `ai_services`, `cloud_providers`, `communication` |
| `created_at` | number | Timestamp |
| `updated_at` | number | Timestamp |

The `IntegrationDefinition` (from registry, passed as `connectionTypes`) adds `displayName` and `description`.

---

## Design

A compact filter toolbar with a search input, category dropdown, and sort control. All filters fit on one row using dropdown selectors.

```
┌──────────────────────────────────────────────────────────────────┐
│ ☰ │ Connections                                                  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Connections                              [+ Add Connection]     │
│  Connect external services so your                               │
│  apps can read and write data.                                   │
│                                                                  │
│  ┌──────────────────────────────────┐                            │
│  │ 🔍 Search connections...      ✕  │  [Category ▾]  [Sort ▾]   │
│  └──────────────────────────────────┘                            │
│                                                                  │
│  Showing 4 of 12 connections                [✕ Clear filters]    │
│                                                                  │
│  ┌───────────────────────┐  ┌───────────────────────┐           │
│  │ 🐘 Postgres           │  │ 💳 Stripe              │           │
│  │    PostgreSQL          │  │    Stripe              │           │
│  │    Databases           │  │    SaaS                │           │
│  │    Updated 3/1/26      │  │    Updated 2/15/26     │           │
│  │ [Configure] [Clone] 🗑│  │ [Configure] [Clone] 🗑│           │
│  └───────────────────────┘  └───────────────────────┘           │
│                                                                  │
│  ── empty filtered state ──                                      │
│  ┌────────────────────────────────────────────┐                  │
│  │  No connections match your filters.        │                  │
│  │  [Clear all filters]                       │                  │
│  └────────────────────────────────────────────┘                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Filter dimensions

| Filter | Type | Options | Default |
|---|---|---|---|
| Search | Text input | Free text (matches name, type, displayName) | Empty |
| Category | `<Select>` dropdown | All categories, Databases, SaaS, AI Services, Cloud Providers, Communication | All categories |
| Sort | `<Select>` dropdown | Recently updated, Name (A-Z), Newest first | Recently updated |

---

## Implementation

### 1. State additions in `connections-client.tsx`

```typescript
const [search, setSearch] = useState('');
const [categoryFilter, setCategoryFilter] = useState<string>('all');
const [sortBy, setSortBy] = useState<'updated' | 'name' | 'created'>('updated');
```

### 2. Filtering + sorting logic

```typescript
const filteredConnections = useMemo(() => {
  let result = connections;

  // Search
  const query = search.trim().toLowerCase();
  if (query) {
    result = result.filter((c) => {
      const typeDef = getTypeDefinition(c.integration_type);
      return (
        c.name.toLowerCase().includes(query) ||
        c.integration_type.toLowerCase().includes(query) ||
        (typeDef?.displayName?.toLowerCase().includes(query) ?? false)
      );
    });
  }

  // Category
  if (categoryFilter !== 'all') {
    result = result.filter((c) => c.category === categoryFilter);
  }

  // Sort
  result = [...result].sort((a, b) => {
    switch (sortBy) {
      case 'name': return a.name.localeCompare(b.name);
      case 'created': return b.created_at - a.created_at;
      case 'updated':
      default: return b.updated_at - a.updated_at;
    }
  });

  return result;
}, [connections, search, categoryFilter, sortBy, getTypeDefinition]);

const hasActiveFilters = search || categoryFilter !== 'all';

const clearAllFilters = () => {
  setSearch('');
  setCategoryFilter('all');
};
```

### 3. Filter toolbar UI

Insert between the header area and the connection cards grid (after line 318 in current code, before error/success alerts end and cards begin). Only render when `connections.length > 0`:

```tsx
{connections.length > 0 && (
  <div className="mt-6 space-y-3">
    {/* Filter toolbar */}
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[200px]">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search connections..."
          className="pl-9 pr-8"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="absolute inset-y-0 right-0 inline-flex items-center px-3 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <Select value={categoryFilter} onValueChange={setCategoryFilter}>
        <SelectTrigger className="w-[150px]">
          <SelectValue placeholder="Category" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All categories</SelectItem>
          {categories.map((cat) => (
            <SelectItem key={cat} value={cat}>
              {categoryLabels[cat] || cat}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={sortBy} onValueChange={setSortBy}>
        <SelectTrigger className="w-[170px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="updated">Recently updated</SelectItem>
          <SelectItem value="name">Name (A-Z)</SelectItem>
          <SelectItem value="created">Newest first</SelectItem>
        </SelectContent>
      </Select>
    </div>

    {/* Results count + clear (only when filters are active) */}
    {hasActiveFilters && (
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Showing {filteredConnections.length} of {connections.length} connections
        </span>
        <Button variant="ghost" size="sm" onClick={clearAllFilters}>
          <X className="mr-1 size-3" />
          Clear filters
        </Button>
      </div>
    )}
  </div>
)}
```

### 4. Replace `connections` with `filteredConnections` in the cards grid

In the existing cards grid (currently `connections.map(...)` around line 366), change to render `filteredConnections` instead:

```tsx
{/* Change from: */}
<div className="mt-6 grid gap-4 md:grid-cols-2">
  {connections.map((connection) => {
    // ... existing card rendering
  })}
</div>

{/* To: */}
<div className="mt-6 grid gap-4 md:grid-cols-2">
  {filteredConnections.map((connection) => {
    // ... existing card rendering (unchanged)
  })}
</div>
```

### 5. Empty filtered state

When `filteredConnections.length === 0` but `connections.length > 0`, show a filtered-empty message instead of the cards grid:

```tsx
{filteredConnections.length === 0 && connections.length > 0 ? (
  <div className="mt-6 flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
    <p>No connections match your filters.</p>
    <Button variant="ghost" size="sm" onClick={clearAllFilters}>
      Clear filters
    </Button>
  </div>
) : (
  <div className="mt-6 grid gap-4 md:grid-cols-2">
    {filteredConnections.map((connection) => {
      // ... existing card rendering
    })}
  </div>
)}
```

### 6. Card enhancement: category badge

Add a category badge to each connection card for scannability. Insert below the connection name/description (`CardDescription`) and above the "Last updated" line:

```tsx
<Badge variant="secondary" className="text-xs font-normal">
  {categoryLabels[connection.category] || connection.category}
</Badge>
```

### 7. Loading skeleton update

Update `connections-loading.tsx` to include a skeleton row for the filter toolbar so the layout doesn't shift when data loads:

```tsx
{/* Add above the skeleton cards grid */}
<div className="mt-6 flex items-center gap-2">
  <Skeleton className="h-9 flex-1" />
  <Skeleton className="h-9 w-[150px]" />
  <Skeleton className="h-9 w-[170px]" />
</div>
```

### 8. New imports needed

```typescript
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
```

Both `Select` and `Badge` are already installed in the project (`src/components/ui/select.tsx`, `src/components/ui/badge.tsx`).

---

## Files to Modify

| File | Changes |
|---|---|
| `src/components/pages/connections/connections-client.tsx` | Add search/filter/sort state, `filteredConnections` useMemo, filter toolbar UI, filtered empty state, category badge on cards, new imports |
| `src/components/pages/connections/connections-loading.tsx` | Add skeleton for filter toolbar row |

No backend changes required — all filtering is client-side on data already loaded by the route loader.

## Acceptance Criteria

- Search input filters connections by name, integration type, and display name
- Category dropdown filters by integration category
- Sort dropdown reorders cards by recently updated, name A-Z, or newest first
- "Showing X of Y" count appears when filters are active
- "Clear filters" button resets search and category filter
- Empty filtered state shows "No connections match your filters" with a clear action
- Filter bar is hidden when there are zero connections (original empty state shown instead)
- Category badge appears on each connection card
- No layout shift — filter toolbar skeleton matches the real toolbar dimensions
- Search is instant (client-side `useMemo`, no debounce needed for this list size)
