# Connections Search + Filters — Implementation Feedback

**Date:** 2026-03-08

---

## Summary

The implementation is solid — filtering logic, search, sort, empty state, and card enhancements all work correctly. A few revisions below, one major (category UI change) and a handful of minor polish items.

---

## 1. Category: Switch from dropdown to tab group (major)

Replace the `<Select>` category dropdown with a `<Tabs>` / `<TabsList>` / `<TabsTrigger>` group. Only show category tabs for categories that have at least one connection in the current workspace.

### Current (dropdown)
```
┌──────────────────────────┐
│ 🔍 Search connections... │  [All categories ▾]  [Recently updated ▾]
└──────────────────────────┘
```

### Target (tabs)
```
┌──────────────────────────┐
│ 🔍 Search connections... │                      [Recently updated ▾]
└──────────────────────────┘
[All] [Databases] [SaaS] [Communication]     ← only populated categories
```

### How

Compute the set of categories that actually have connections:

```typescript
const activeCategories = useMemo(() => {
  const cats = new Set(connections.map((c) => c.category));
  // Maintain stable ordering from the categories prop
  return categories.filter((cat) => cats.has(cat));
}, [connections, categories]);
```

Then replace the category `<Select>` with:

```tsx
{activeCategories.length > 1 && (
  <Tabs value={categoryFilter} onValueChange={setCategoryFilter}>
    <TabsList>
      <TabsTrigger value="all">All</TabsTrigger>
      {activeCategories.map((cat) => (
        <TabsTrigger key={cat} value={cat}>
          {categoryLabels[cat] || cat}
        </TabsTrigger>
      ))}
    </TabsList>
  </Tabs>
)}
```

Notes:
- Only render tabs when there are 2+ distinct categories (if everything is `databases`, no point showing tabs)
- `Tabs`/`TabsList`/`TabsTrigger` are already imported for the picker dialog
- The `Select` import can stay since it's still used by the sort dropdown

### Layout adjustment

With tabs on a separate row below the search + sort line, the toolbar becomes:

```tsx
<div className="mt-6 space-y-3">
  {/* Row 1: search + sort */}
  <div className="flex flex-wrap items-center gap-2">
    <div className="relative min-w-[220px] flex-1">
      {/* search input (unchanged) */}
    </div>
    <Select ...>{/* sort dropdown (unchanged) */}</Select>
  </div>

  {/* Row 2: category tabs (only if 2+ categories) */}
  {activeCategories.length > 1 && (
    <Tabs value={categoryFilter} onValueChange={setCategoryFilter}>
      <TabsList>...</TabsList>
    </Tabs>
  )}

  {/* Row 3: results count (only when filters active) */}
  {hasActiveFilters && (
    <div className="flex ...">...</div>
  )}
</div>
```

---

## 2. Category label in card — simplify the resolution

The current logic is:
```typescript
const categoryLabel = categoryLabels[typeDef?.category ?? connection.category] ??
  (typeDef?.category ?? connection.category);
```

`typeDef?.category` and `connection.category` will always be the same value (the category comes from the registry at creation time). Simplify to:

```typescript
const categoryLabel = categoryLabels[connection.category] || connection.category;
```

---

## 3. Loading skeleton doesn't match the toolbar

The skeleton has a single `<Skeleton className="h-10 w-64 mb-4" />` which doesn't match the new toolbar layout (search bar + dropdowns). Update to reflect the actual toolbar structure:

```tsx
{/* Filter toolbar skeleton */}
<div className="mt-6 space-y-3">
  <div className="flex flex-wrap items-center gap-2">
    <Skeleton className="h-9 min-w-[220px] flex-1" />
    <Skeleton className="h-9 w-[170px]" />
  </div>
  <Skeleton className="h-9 w-[300px]" />   {/* tabs row */}
</div>
```

---

## 4. `hasActiveFilters` should also reset `categoryFilter` check label

When switching from dropdown to tabs, `clearAllFilters` should also reset `categoryFilter` — this is already handled, just confirming it stays intact after the refactor.

---

## 5. Minor: empty filtered state uses `Card` instead of lightweight centered text

The plan spec'd a lightweight centered `<div>` for the empty filtered state, but the implementation uses a full `<Card>` with `CardHeader` + `CardContent`. This is fine — the card treatment actually looks nicer and more consistent. No change needed, just noting the deviation from plan.

---

## Files to touch

| File | Changes |
|---|---|
| `src/components/pages/connections/connections-client.tsx` | Replace category `Select` with `Tabs`, compute `activeCategories`, simplify `categoryLabel` |
| `src/components/pages/connections/connections-loading.tsx` | Update skeleton to match search + sort + tabs layout |
