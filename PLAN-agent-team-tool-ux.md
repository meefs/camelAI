# Agent Team Tool UX Plan

## Overview

The Claude agent can spawn sub-agent teams using the `TeamCreate` tool and receive results back via `<teammate-message>` XML in user-role messages. Currently both of these render poorly:

1. **TeamCreate** falls through to `GenericDetails` and shows raw JSON for input/output
2. **Teammate messages** appear as regular user messages with raw XML tags visible

This plan addresses both issues to make the agent team experience feel native.

---

## Goals

- Give `TeamCreate` a proper summary line, status, and detail view matching the existing tool call system
- Parse `<teammate-message>` XML out of user messages and render them as distinct "teammate update" blocks rather than user chat bubbles
- Keep changes minimal and consistent with existing patterns

---

## 1. TeamCreate Tool Call Styling

### Current Behavior

TeamCreate falls through to the `default` case in `tool-details.tsx`, which renders `GenericDetails` - raw JSON blobs for input and output:

```
┌──────────────────────────────────────────────────┐
│ ●  TeamCreate                                  ▸ │  ← no custom summary text
└──────────────────────────────────────────────────┘
  Expanded:
  ┊  Input
  ┊  ┌────────────────────────────────────────────┐
  ┊  │ {                                          │
  ┊  │   "team_name": "animation-fixes",          │
  ┊  │   "description": "Fix and enhance SVG..."  │
  ┊  │ }                                          │
  ┊  └────────────────────────────────────────────┘
  ┊  Output
  ┊  ┌────────────────────────────────────────────┐
  ┊  │ {                                          │
  ┊  │   "team_name": "animation-fixes",          │
  ┊  │   "team_file_path": "/home/sprite/..."     │
  ┊  │   "lead_agent_id": "team-lead@anim..."     │
  ┊  │ }                                          │
  ┊  └────────────────────────────────────────────┘
```

### Target Behavior

```
┌──────────────────────────────────────────────────┐
│ ◉  Creating team animation-fixes...            ▸ │  ← running (blue pulse)
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│ ●  Created team animation-fixes                ▸ │  ← complete (green)
└──────────────────────────────────────────────────┘
  Expanded:
  ┊  Team:          animation-fixes
  ┊  Description:   Fix and enhance SVG animation presets in parallel
  ┊  Lead agent:    team-lead@animation-fixes
  ┊  Config:        config.json  ← clickable FileLink
```

### Implementation

#### A. Add summary in `tool-summary.ts`

Add a new case in the `switch (name)` block (after the `Task` case, around line 151):

```typescript
case 'TeamCreate': {
  const teamName = typeof inputRecord.team_name === 'string' ? inputRecord.team_name : '';
  if (status === 'running') {
    if (!teamName) return { action: 'Creating team...' };
    return { action: `Creating team ${teamName}...` };
  }
  return { action: `Created team ${teamName || 'team'}` };
}
```

**File:** `src/components/tool-call/tool-summary.ts` (insert after line 151)

#### B. Create `TeamCreateDetails` component

Create a new file at `src/components/tool-call/details/team-create-details.tsx`:

```tsx
"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { DetailRow } from './shared';
import { getResultText } from '../tool-utils';

interface TeamCreateDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
}

export function TeamCreateDetails({ tool, result }: TeamCreateDetailsProps) {
  const input = tool?.input ?? {};
  const teamName = typeof input.team_name === 'string' ? input.team_name : '';
  const description = typeof input.description === 'string' ? input.description : '';

  // Parse structured fields from result JSON
  let leadAgentId = '';
  let configPath = '';
  if (result) {
    const text = getResultText(result);
    try {
      const parsed = JSON.parse(text);
      leadAgentId = typeof parsed.lead_agent_id === 'string' ? parsed.lead_agent_id : '';
      configPath = typeof parsed.team_file_path === 'string' ? parsed.team_file_path : '';
    } catch {
      // Result isn't JSON - ignore
    }
  }

  // Extract just the filename from the config path for display
  const configFilename = configPath ? configPath.split('/').pop() || configPath : '';

  return (
    <div className="space-y-1">
      {teamName && <DetailRow label="Team:" value={teamName} />}
      {description && <DetailRow label="Description:" value={description} />}
      {leadAgentId && <DetailRow label="Lead agent:" value={leadAgentId} mono />}
      {configPath && (
        <DetailRow
          label="Config:"
          value={configFilename}
          asFileLink
          filePath={configPath}
          copyValue={configPath}
        />
      )}
    </div>
  );
}
```

#### C. Register in `tool-details.tsx`

Add the import at the top of the file:

```typescript
import { TeamCreateDetails } from './details/team-create-details';
```

Add a new case in the switch block (after the `Bash` case or wherever appropriate, before `default`):

```typescript
case 'TeamCreate':
  content = <TeamCreateDetails tool={tool} result={result} />;
  break;
```

**File:** `src/components/tool-call/tool-details.tsx`

---

## 2. Teammate Message Rendering

### Current Behavior

Teammate messages arrive as `role: "user"` messages with content like:

```
<teammate-message teammate_id="team-lead">
I've completed the `pixelDissolve` improvement...

TypeScript compiles cleanly with no errors.
</teammate-message>
```

Because there is no parsing for this XML, the entire content (including the opening and closing tags) renders as a right-aligned user chat bubble. This is confusing - it looks like the human user sent it.

### Target Behavior

Teammate messages should render as left-aligned, visually distinct blocks - not as user bubbles and not as assistant messages. They should look like an "incoming report" from a sub-agent.

```
  ┌─ teammate icon ───────────────────────────────┐
  │  team-lead                                     │
  │                                                │
  │  I've completed the `pixelDissolve`            │
  │  improvement in `/home/sprite/svg-animator/    │
  │  app/lib/animations.ts` (lines 657-703).       │
  │  Here's a summary of what changed:             │
  │  ...                                           │
  │  TypeScript compiles cleanly with no errors.   │
  └────────────────────────────────────────────────┘
```

### Design

The teammate message should:
- Be **left-aligned** (like assistant messages, not right-aligned like user messages)
- Have a subtle visual distinction from normal assistant text:
  - A small header showing the teammate ID (e.g., "team-lead") with a `Users` icon from lucide
  - A left border accent (using `border-l-2 border-blue-500/40`) to visually group it
  - A light background tint (`bg-muted/20 rounded-lg p-3`)
- Render the inner content as **markdown** (teammate messages contain code references, backticks, etc.)
- **Not** show user attribution footer ("Sent by ... at ...")
- **Not** show the copy action row that user messages show (or show it on hover, adapted)

### Implementation

#### A. Parse teammate messages in `message-bubble.tsx`

Add a regex and parser function near the existing `stripSystemMessageTags` function:

```typescript
const TEAMMATE_MESSAGE_REGEX = /^<teammate-message\s+teammate_id="([^"]+)">\n?([\s\S]*?)\n?<\/teammate-message>$/;

interface ParsedTeammateMessage {
  teammateId: string;
  content: string;
}

function parseTeammateMessage(rawContent: string): ParsedTeammateMessage | null {
  // Strip system message tags first, then check for teammate message
  const stripped = stripSystemMessageTags(rawContent).trim();
  const match = stripped.match(TEAMMATE_MESSAGE_REGEX);
  if (!match) return null;
  return {
    teammateId: match[1] ?? '',
    content: (match[2] ?? '').trim(),
  };
}
```

**File:** `src/components/message-bubble.tsx` (add near line 54, after `stripSystemMessageTags`)

#### B. Handle teammate messages in `MessageBubble`

In the `MessageBubble` component, add an early check at the start of the `message.role === 'user'` branch (around line 354), **before** the existing author parsing logic:

```typescript
if (message.role === 'user') {
  // Check for teammate messages first
  const rawText = typeof message.content === 'string'
    ? message.content
    : message.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .filter(Boolean)
        .join('\n');

  const teammateMessage = parseTeammateMessage(rawText);
  if (teammateMessage) {
    return (
      <TeammateMessageBubble
        teammateId={teammateMessage.teammateId}
        content={teammateMessage.content}
        timestamp={message.created_at}
      />
    );
  }

  // ... existing author parsing code continues ...
}
```

#### C. Create `TeammateMessageBubble` component

Add this component either in `message-bubble.tsx` (above the `MessageBubble` export) or as a separate file at `src/components/teammate-message-bubble.tsx`. Keeping it in `message-bubble.tsx` is simpler since it's small and uses the same imports:

```tsx
import { Users } from 'lucide-react';

function TeammateMessageBubble({
  teammateId,
  content,
  timestamp,
}: {
  teammateId: string;
  content: string;
  timestamp: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="max-w-none border-l-2 border-blue-500/40 bg-muted/20 rounded-lg pl-3 pr-3 py-2">
        <div className="flex items-center gap-1.5 mb-1.5">
          <Users className="h-3.5 w-3.5 text-blue-500/70" />
          <span className="text-xs font-medium text-blue-500/70">{teammateId}</span>
        </div>
        <div className="max-w-none">
          <MarkdownRenderer content={content} />
        </div>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
        <span className="text-muted-foreground text-xs mr-1">
          {formatMessageTime(timestamp)}
        </span>
      </div>
    </div>
  );
}
```

**Key design decisions:**
- `Users` icon from lucide-react (already in the project's lucide dependency) signals "team/group"
- `border-l-2 border-blue-500/40` gives a subtle blue accent that differentiates from regular text without being loud
- `bg-muted/20` provides a very subtle background tint
- The teammate ID is shown in a small blue label (matches the border accent)
- The content is rendered via `MarkdownRenderer` so code blocks, backticks, etc. all work
- Left-aligned like assistant messages (default `flex-col` without `items-end`)

#### D. Update `hasVisibleContent` to handle teammate messages

The existing `hasVisibleContent` function strips `<chiridion system message>` tags. We need it to also recognize teammate messages as visible content so they aren't accidentally hidden. Since teammate messages have actual text content inside the XML, the existing logic should work correctly - the content won't be empty after stripping system tags. No change needed here.

#### E. Update `contentToString` for copy support

In the `contentToString` function (`message-bubble.tsx`), teammate message XML should be stripped for copying. Add a strip function:

```typescript
function stripTeammateMessageTags(text: string): string {
  return text.replace(
    /<teammate-message\s+teammate_id="[^"]*">\n?/g, ''
  ).replace(/<\/teammate-message>/g, '').trim();
}
```

Then in `contentToString`, apply it after `stripSystemMessageTags`:

```typescript
if (block.type === 'text') return stripTeammateMessageTags(stripSystemMessageTags(block.text));
```

This ensures that when copying a teammate message, you get the plain text content without XML tags.

---

## 3. Edge Cases

### Multiple teammate messages in one user message

If multiple `<teammate-message>` blocks arrive in a single message, the regex approach (which expects the entire content to be one teammate message) won't match. Handle this gracefully:

- If the regex doesn't match a single full-message pattern, fall through to the existing user message rendering
- The `stripTeammateMessageTags` function will still strip the XML tags for display, so at worst the content shows as a user message without raw XML

For a more robust approach, if we find this is common, a follow-up could split on multiple teammate-message blocks. For now the single-message pattern covers the observed format.

### Teammate message with author prefix

The `ChatThreadDO.formatAttributedUserMessage` adds `[Name (email)]:` prefixes to user messages. If a teammate message passes through this pipeline, the content might be prefixed. The `parseTeammateMessage` function works on the raw text before author stripping, so:

- If the message is `[Name (email)]: <teammate-message ...>`, the author parsing in `parseMessageAuthor` would strip the prefix and return content starting with `<teammate-message`. The teammate check happens on the `rawText` **before** author parsing, so we should be fine - `rawText` includes the full content.

Actually, to be safe, the teammate check should operate on content that has had system message tags stripped but **not** author prefixes stripped. The current implementation gets `rawText` from the raw message content, which is correct. The regex should tolerate leading/trailing whitespace (the `.trim()` in `parseTeammateMessage` handles this).

### Streaming teammate messages

Teammate messages arrive as complete `user` role messages (not streamed incrementally), so there's no partial-render concern.

---

## Files Summary

| File | Change | Description |
|------|--------|-------------|
| `src/components/tool-call/tool-summary.ts` | Edit | Add `TeamCreate` case with running/complete tense |
| `src/components/tool-call/tool-details.tsx` | Edit | Import + register `TeamCreateDetails` component |
| `src/components/tool-call/details/team-create-details.tsx` | **New** | Detail renderer showing team name, description, lead agent, config link |
| `src/components/message-bubble.tsx` | Edit | Add teammate message parsing + `TeammateMessageBubble` component |

---

## Implementation Order

1. **TeamCreate tool summary** (`tool-summary.ts`) - quickest win, gives proper collapsed text
2. **TeamCreateDetails** (`team-create-details.tsx` + `tool-details.tsx`) - proper expanded state
3. **Teammate message parsing** (`message-bubble.tsx`) - regex + parser function
4. **TeammateMessageBubble** (`message-bubble.tsx`) - the rendered component
5. **Copy support** (`message-bubble.tsx`) - strip XML tags from copy text

---

## Acceptance Criteria

- [ ] TeamCreate tool shows "Creating team {name}..." while running and "Created team {name}" when complete
- [ ] TeamCreate expanded state shows Team, Description, Lead agent, and Config as structured `DetailRow` fields (not raw JSON)
- [ ] Config path is a clickable `FileLink`
- [ ] Teammate messages render left-aligned with blue accent border and `Users` icon
- [ ] Teammate ID is displayed as a small label above the message content
- [ ] Teammate message content renders as markdown (code blocks, backticks, etc.)
- [ ] Raw `<teammate-message>` XML tags are never visible to the user
- [ ] Copying a teammate message gives plain text without XML tags
- [ ] Regular user messages are unaffected by the teammate parsing
