# Connection Selection UX Improvements

Improve the styling and UX of selecting a connection across three surfaces: Connections tab dialog, New Chat welcome screen, and Onboarding data-interests.

---

## Summary of Changes

| Surface | What Changes |
|---------|-------------|
| **Connections tab dialog** | Add search bar above category tabs |
| **New chat screen** | Keep "Your connected tools" as-is; replace "Connect your tools" with a collapsible "Add another connection" button that expands to reveal search + category tabs + integration grid |
| **Onboarding data-interests** | Replace pagination with scroll+fade, add category tabs |

All three share a new `ConnectionPicker` component with configurable props for variant, mode, and density.

---

## Category Tab Labels

User-facing labels for the existing `IntegrationCategory` values:

| Internal | Tab Label |
|----------|-----------|
| `all` | All |
| `databases` | Data |
| `saas` | SaaS |
| `ai_services` | AI |
| `cloud_providers` | Cloud |
| `communication` | Comms |

These are display-only. No changes to the `IntegrationCategory` type.

---

## ASCII Mockups

### Connections Tab Dialog (large variant, search added)

```
┌──────────────────────────────────────────────────────────────┐
│  Add a connection                                        [x] │
│  Choose a service to connect.                                │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ [Q] Search 42+ integrations...                         │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  [All] [Data] [SaaS] [AI] [Cloud] [Comms]                   │
│                                                              │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────┐ │
│  │ [pg] PostgreSQL  │ │ [my] MySQL       │ │ [sb] Supabase│ │
│  │     API Key   [+]│ │     API Key   [+]│ │   API Key [+]│ │
│  ├──────────────────┤ ├──────────────────┤ ├──────────────┤ │
│  │ [bq] BigQuery   │ │ [ne] Neon        │ │ [sf] Snowfl..│ │
│  │     API Key   [+]│ │     API Key   [+]│ │   API Key [+]│ │
│  └──────────────────┘ └──────────────────┘ └──────────────┘ │
│                      (scrolls vertically)                    │
└──────────────────────────────────────────────────────────────┘
```

Minimal change: insert search `Input` between dialog header and `Tabs`. Existing 3-column card grid and `ScrollArea` stay.

### New Chat Screen (single section with collapsible "add connection" at bottom)

One section titled "Your connected tools". Connected tool pills render as today
(logo + user-given name). At the bottom of this section, a collapsible
"Add another connection" button expands to reveal the full integration picker.

#### Has Connections - Collapsed (default)

```
Your connected tools                              View all →

[pg·My Postgres]  [stripe·Stripe Prod]  [slack·Team Slack]

  ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
  ╎  + Add another connection        [pg][sf][hb][sl]  ╎
  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
                                      ↑ overlapping mini logos
```

#### Has Connections - Expanded (after click)

```
Your connected tools                              View all →

[pg·My Postgres]  [stripe·Stripe Prod]  [slack·Team Slack]

  ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
  ╎  + Add another connection        [pg][sf][hb][sl]  ╎
  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘

  [Q] Search connections...

  [All] [Data] [SaaS] [AI] [Cloud] [Comms]

  [pg·Postgres]  [sf·Snowflake]  [hb·HubSpot]
  [gh·GitHub]    [sh·Sheets]     [fg·Figma]
  [gm·Gmail]     [sl·Salesforce] [li·Linear]
  ...
                   ░░░ fade gradient ░░░
```

#### No Connections (new user)

When the user has zero connections, the section title changes to "Connect your tools"
and the connected pills row is replaced with ~5 popular connection pills that the user
can click directly. Below those, the collapsible button reads "Explore all connections"
and its overlapping logo stack uses DIFFERENT integrations than the 5 shown above.

```
Connect your tools                                View all →

[stripe·Stripe]  [slack·Slack]  [pg·PostgreSQL]  [gh·GitHub]  [notion·Notion]

  ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
  ╎  + Explore all connections          [hb][at][sf][oa][bq]  ╎
  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
                                         ↑ different logos than the 5 above
```

The 5 featured pills use the same styling as the existing `IntegrationButtons` (compact
pill with logo + name). Clicking one fills the prompt with "Let's connect [name]".

Two curated lists needed:
- `FEATURED_CONNECTIONS`: ~5 popular integrations shown as pills (e.g., Stripe, Slack, PostgreSQL, GitHub, Notion)
- `LOGO_STACK_CONNECTIONS`: ~5 different integrations for the button preview (e.g., HubSpot, Airtable, Snowflake, OpenAI, BigQuery)

#### "Add another connection" Button Design

- Full-width button within the section
- Left side: `+` icon + text ("Add another connection" when has connections, "Explore all connections" when none)
- Right side: overlapping stack of ~4-5 small integration logos (like avatar groups)
- Default state: muted/subtle (border-dashed or low-contrast border, text-muted-foreground)
- Hover state: border and text brighten to full contrast
- Click: smoothly expands to reveal the picker below (animated height transition)
- Clicking again collapses the picker

#### Overlapping Logo Stack

The mini logo stack shows ~4-5 popular integration logos overlapping like GitHub's
contributor avatars. Each logo is small (~20-24px), uses `-ml-1.5` for overlap and
`ring-2 ring-background` to create clean separation. Curated subset: Stripe, Slack,
PostgreSQL, GitHub, Notion.

#### Key Behaviors
- Expand/collapse animated via CSS transition or shadcn `Collapsible` component
- No container outlines around the section -- pills and button sit directly in flow
- Expanded picker uses `ConnectionPicker` component (compact variant, single-action mode)
- The expanded picker content has maxHeight + fade gradient for scroll

#### Prompt Behavior Preserved
- Connected tool click → `"Use my [name] connection to create "`
- Unconnected tool click (from expanded picker) → `"Let's connect [displayName]"`

### Onboarding Data Interests (compact variant, multi-select, scroll+fade)

```
  Files  (drag and drop into chat)
  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
  │   CSV   │ │  Excel  │ │  SQLite │ │  JSON   │
  └─────────┘ └─────────┘ └─────────┘ └─────────┘

  Connections  (live API access)

  ┌──────────────────────────────────────────────────────┐
  │ [Q] Search integrations...                           │
  └──────────────────────────────────────────────────────┘
  [All] [Data] [SaaS] [AI] [Cloud] [Comms]

  ┌──────────────────────────────────────────────────────┐
  │ [*Stripe]  [Slack]  [*Notion]  [HubSpot]            │  maxHeight: ~280px
  │ [GitHub]  [Airtable]  [*PostgreSQL]  [OpenAI]       │
  │ [BigQuery]  [Salesforce]  [Linear]  [Sentry]        │
  │ [Mailchimp]  [PostHog]  [Mixpanel]  [Typeform]      │
  │                                                      │
  │                 ░░░ fade gradient ░░░                 │
  └──────────────────────────────────────────────────────┘
    (* = selected, gets border-foreground bg-muted)
```

Key changes:
- Pagination removed entirely (no Previous/Next buttons)
- Category tabs added
- Scroll+fade replaces page navigation
- Files section untouched

---

## New Files to Create

### 1. `src/components/connection-picker/use-connection-filter.ts`

Custom hook that manages search + category filter state:

```typescript
export function useConnectionFilter(
  integrations: Array<{ type: string; displayName: string; category: string }>,
  excludeTypes?: string[]
) → {
  searchQuery, setSearchQuery,
  activeCategory, setActiveCategory,
  filteredIntegrations,
  categories
}
```

- Filters by `activeCategory` (unless 'all')
- Filters by `searchQuery` (fuzzy match on displayName and type)
- Returns unique categories from the integration list
- Reusable across all three surfaces

### 2. `src/components/connection-picker/connection-chip.tsx`

Reusable chip/button for a single integration:

```typescript
interface ConnectionChipProps {
  type: string;
  displayName: string;
  variant: 'large' | 'compact';
  isSelected?: boolean;      // multi-select: currently toggled on
  showAuthType?: string;     // e.g., "OAuth" or "API Key" (large variant only)
  onClick: () => void;
}
```

Styling:
- `compact` variant: `inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-sm` (current pill style from `integration-buttons.tsx`)
- `large` variant: `flex items-center gap-3 rounded-lg border bg-card p-3` with icon box + name + auth type + Plus icon (current card style from `connections-client.tsx`)
- `isSelected`: `border-foreground bg-muted font-medium`

### 3. `src/components/connection-picker/index.tsx`

Main component. Props:

```typescript
interface ConnectionPickerProps {
  integrations: Array<{ type: string; displayName: string; category: string }>;
  mode: 'single-action' | 'multi-select';
  variant: 'large' | 'compact';
  showSearch?: boolean;               // default: true
  showCategoryTabs?: boolean;         // default: true
  maxHeight?: string;                 // CSS value for scroll area
  selectedIds?: string[];             // multi-select: currently selected
  onToggle?: (id: string) => void;    // multi-select callback
  onSelect?: (integration: { type: string; displayName: string }) => void;  // single-action click
  excludeTypes?: string[];            // hide specific types (e.g., ['other'])
  searchPlaceholder?: string;
}
```

Internal structure:
1. Search `Input` with `Search` icon and `X` clear button
2. Category tab bar: horizontal flex of toggle buttons using `CATEGORY_TAB_LABELS`
3. Scrollable chip grid with fade gradient overlay
4. In `single-action` mode: clicking a chip calls `onSelect`
5. In `multi-select` mode: clicking a chip toggles selection via `onToggle`, selected items get highlight styling

Fade gradient implementation:
- Parent `div` with `position: relative`
- Scrollable `div` with `overflow-y-auto` and `maxHeight`
- Fade overlay: `div` with `pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background to-transparent`
- Hide fade when scrolled to bottom or content doesn't overflow

---

## Existing Files to Modify

### 4. `src/components/pages/connections/connections-client.tsx`

**Change:** Add search bar to the "Add a connection" dialog.

In the `<Dialog>` section (around line 390):
- Add `searchQuery` state
- Insert an `Input` with `Search` icon between `DialogDescription` and `Tabs`
- Filter `connectionTypes` by `searchQuery` before rendering the grid in each tab
- Keep existing `Tabs` component and 3-column card grid as-is
- Alternatively, use `useConnectionFilter` hook from the new module

This is the simplest change of the three: just add search filtering to the existing dialog.

### 5. `src/components/welcome-screen/index.tsx`

**Change:** Merge the two conditional sections into one section with connected tools + collapsible "add connection" button.

Current logic (lines 225-226):
```typescript
const showYourConnections = hasConnections;
const showConnectSuggestions = !hasConnections;
```

New logic: Always show a single section. Title adapts: "Your connected tools" when connections exist, "Connect your tools" when none.

- Keep `ConnectedTools` component for rendering existing connections (no change to that component)
- Replace `IntegrationButtons` with a new collapsible "Add another connection" button + `ConnectionPicker`
- Import `ConnectionPicker`, the integration registry, and shadcn `Collapsible`/`CollapsibleTrigger`/`CollapsibleContent`
- Build `allIntegrationDefs` from `INTEGRATION_REGISTRY` (static import)

Replace the two conditional sections (lines 307-324) with:

```tsx
<section className="space-y-4">
  <SectionHeader
    title={hasConnections ? "Your connected tools" : "Connect your tools"}
    linkHref="/connections"
  />

  {/* Connected tool pills (when connections exist) OR featured pills (new user) */}
  {hasConnections ? (
    <ConnectedTools connections={connections} onSelect={handleConnectionSelect} />
  ) : (
    <IntegrationButtons
      integrations={FEATURED_CONNECTIONS}
      onSelect={handleIntegrationSelect}
    />
  )}

  {/* Collapsible "Add another connection" with expanded picker */}
  <Collapsible open={addConnectionOpen} onOpenChange={setAddConnectionOpen}>
    <CollapsibleTrigger asChild>
      <button className="w-full flex items-center justify-between rounded-lg
        border border-dashed border-muted-foreground/25 px-4 py-3
        text-muted-foreground hover:border-muted-foreground/50
        hover:text-foreground transition-colors">
        <span className="flex items-center gap-2 text-sm">
          <Plus className="size-4" />
          {hasConnections ? "Add another connection" : "Explore all connections"}
        </span>
        <LogoStack />
      </button>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div className="pt-4">
        <ConnectionPicker
          integrations={allIntegrationDefs}
          mode="single-action"
          variant="compact"
          maxHeight="240px"
          onSelect={handleIntegrationSelect}
          excludeTypes={['other']}
        />
      </div>
    </CollapsibleContent>
  </Collapsible>
</section>
```

The `LogoStack` is a small inline component rendering ~4-5 overlapping `IntegrationIcon`
elements (size 20, `-ml-1.5` overlap, `ring-2 ring-background` for separation).

### 6. `src/components/onboarding/data-interest-grid.tsx`

**Change:** Replace pagination with `ConnectionPicker` in multi-select mode.

- Remove: `integrationPage` state, `INTEGRATIONS_PER_PAGE`, pagination buttons, `pageIntegrationOptions`
- Keep: Files section (lines 66-91) exactly as-is
- Replace the Connections section (lines 93-181) with:

```tsx
<section>
  <div className="mb-3 text-sm font-medium text-muted-foreground">
    Connections
    <span className="ml-2 text-xs font-normal">(live API access)</span>
  </div>
  <ConnectionPicker
    integrations={integrationOptions.map(opt => ({
      type: opt.id,
      displayName: opt.label,
      category: INTEGRATION_REGISTRY[opt.id]?.category ?? 'saas',
    }))}
    mode="multi-select"
    variant="compact"
    maxHeight="280px"
    selectedIds={selectedIntegrations}
    onToggle={onToggleIntegration}
    excludeTypes={['other']}
    searchPlaceholder="Search integrations..."
  />
</section>
```

### 7. Files to Remove

No files are removed. Both `connected-tools.tsx` and `integration-buttons.tsx` are **kept**:
- `connected-tools.tsx` renders connected tool pills (has connections state)
- `integration-buttons.tsx` renders the ~5 featured connection pills (no connections state)

The `FEATURED_INTEGRATIONS` list in `integration-buttons.tsx` will be updated to the
curated `FEATURED_CONNECTIONS` list (Stripe, Slack, PostgreSQL, GitHub, Notion) and
a separate `LOGO_STACK_CONNECTIONS` list will be added for the button preview logos.

---

## Implementation Order

1. **Create** `use-connection-filter.ts` hook (zero dependencies beyond React)
2. **Create** `connection-chip.tsx` component (depends on `IntegrationIcon`, `cn`, lucide `Plus`)
3. **Create** `connection-picker/index.tsx` (depends on steps 1-2, plus `Input` component)
4. **Modify** `connections-client.tsx` - add search bar to dialog
5. **Modify** `data-interest-grid.tsx` - replace pagination with ConnectionPicker
6. **Modify** `welcome-screen/index.tsx` - single section with connected tools + collapsible add button + ConnectionPicker
7. **Modify** `integration-buttons.tsx` - update `FEATURED_INTEGRATIONS` list, add `LOGO_STACK_CONNECTIONS` export

---

## Edge Cases

- **Empty search results**: Show "No integrations found" centered text in the scroll area
- **Zero connections (new user, chat page)**: Section title becomes "Connect your tools"; 5 featured connection pills shown instead of connected tools; button text becomes "Explore all connections"; logo stack uses different integrations than the 5 featured
- **`other` integration type**: Excluded via `excludeTypes` in all three surfaces (it's for custom integrations created via MCP, not browse)
- **Category with zero filtered results**: Show "No integrations found" within the grid area
- **Content doesn't overflow maxHeight**: Hide the fade gradient (check via `scrollHeight <= clientHeight` on mount and filter changes)
- **Keyboard accessibility**: All chips are `<button>` elements. Search input is focusable. Tab buttons are keyboard navigable.

---

## Verification

1. **Connections tab**: Open `/connections` → click "Add Connection" → verify search bar appears above tabs → type to filter → verify results update in real-time → verify category tabs still work → verify clicking a connection opens the add form
2. **New chat screen**: Navigate to `/chat` → verify "Your connected tools" section with connected pill buttons → verify "Add another connection" button below with overlapping logos → hover button and verify it brightens → click button and verify picker expands with animation → verify search/category tabs/scroll+fade in expanded picker → verify clicking a connection fills prompt with "Let's connect..." → collapse and verify it animates closed → test with zero connections: section title should be "Connect your tools", button text "Add a connection"
3. **Onboarding**: Navigate to `/onboarding/data-interests` → verify Files section unchanged → verify Connections section has search bar + category tabs → verify no pagination buttons → verify scroll + fade on the integration grid → verify multi-select toggling works → verify selected state persists through search/filter changes
4. **Run existing tests**: `bun run test:run` to verify no regressions
