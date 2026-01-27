# Tool Call UX Improvements: Search, Run, and Read (Skill)

## Summary

Fix three tense/state bugs in `src/components/tool-call/tool-summary.ts` where tool call labels don't correctly reflect active vs completed states.

---

## Bug 1: Search (Glob & Grep) — stuck in active tense when no results

**File:** `src/components/tool-call/tool-summary.ts`

**Problem:** Both `Glob` and `Grep` cases rely on `parseCountFromResult(result)` returning a count to switch to past tense. When the search finds zero results, the regex `/Found\s+(\d+)\s+(files|matches)/i` may not match (the result text may say something different for zero results), so `count` is `null` and it falls through to the active-tense string forever.

**Fix for `Glob` (line 119-121):**

Replace:
```ts
case 'Glob': {
  const count = parseCountFromResult(result);
  return { action: count !== null ? `Found ${count} files` : 'Searching for files...' };
}
```

With:
```ts
case 'Glob': {
  const count = parseCountFromResult(result);
  if (count !== null) return { action: `Found ${count} files` };
  if (result) return { action: 'No files found' };
  const pattern = typeof inputRecord.pattern === 'string' ? inputRecord.pattern : '';
  if (isStreaming && !pattern) return { action: 'Searching for files...' };
  return { action: `Searching for "${truncate(pattern || 'files', 20)}"...` };
}
```

**Fix for `Grep` (lines 122-130):**

Replace:
```ts
case 'Grep': {
  const count = parseCountFromResult(result);
  if (count !== null) return { action: `Found ${count} matches` };
  const pattern = typeof inputRecord.pattern === 'string' ? inputRecord.pattern : '';
  if (isStreaming && !pattern) {
    return { action: 'Searching...' };
  }
  return { action: `Searching for "${truncate(pattern || 'pattern', 20)}"...` };
}
```

With:
```ts
case 'Grep': {
  const count = parseCountFromResult(result);
  if (count !== null) return { action: `Found ${count} matches` };
  if (result) return { action: 'No matches found' };
  const pattern = typeof inputRecord.pattern === 'string' ? inputRecord.pattern : '';
  if (isStreaming && !pattern) {
    return { action: 'Searching...' };
  }
  return { action: `Searching for "${truncate(pattern || 'pattern', 20)}"...` };
}
```

**Key insight:** Add `if (result) return { action: 'No files found' / 'No matches found' };` right after the count check. If a `result` exists but `parseCountFromResult` returned null, the tool completed with no matches.

---

## Bug 2: Run (Bash) — no active vs past tense distinction

**File:** `src/components/tool-call/tool-summary.ts`

**Problem (lines 106-117):** Once `description` or `command` is available (which happens almost immediately as input streams in), the summary jumps straight to `"Ran ..."` even while the command is still running. The code only shows active tense when there is zero input.

**Fix:** Use `isStreaming && !result` to distinguish active from completed state.

Replace:
```ts
case 'Bash': {
  const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
  const command = typeof inputRecord.command === 'string' ? inputRecord.command : '';
  if (isStreaming && !description && !command) {
    return { action: 'Running command...' };
  }
  return {
    action: description
      ? `Ran ${description}`
      : `Ran ${truncate(command || 'command', 30)}`,
  };
}
```

With:
```ts
case 'Bash': {
  const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
  const command = typeof inputRecord.command === 'string' ? inputRecord.command : '';
  const label = description || truncate(command || 'command', 30);
  if (isStreaming && !result) {
    if (!description && !command) return { action: 'Running command...' };
    return { action: `Running ${label}...` };
  }
  return { action: `Ran ${label}` };
}
```

**Key insight:** Check `isStreaming && !result` (not just missing input) to decide active tense. Once input is available but no result yet, show `"Running {label}..."`. Only show `"Ran {label}"` after result arrives.

---

## Bug 3: Read (Skill) — flips between active and past tense

**File:** `src/components/tool-call/tool-summary.ts`

**Problem (lines 136-147):** The `Skill` case uses `isStreaming` alone to decide tense. Because `isStreaming` reflects the overall message streaming state (not just this tool), the skill label flip-flops: it shows "Read skill frontend-design" briefly when the result arrives, then goes back to "Reading skill..." because the assistant message is still streaming, then back again.

**Fix:** Use `result` as the tense signal (same pattern as other tools), not `isStreaming` alone.

Replace:
```ts
case 'Skill': {
  const skill = typeof inputRecord.skill === 'string' ? inputRecord.skill : '';
  if (isStreaming) {
    return { action: 'Reading skill...' };
  }
  const path = skill ? `/home/claude/.claude/skills/${skill}/SKILL.md` : '';
  return {
    action: 'Read skill',
    filename: skill || 'skill',
    path: path || undefined,
  };
}
```

With:
```ts
case 'Skill': {
  const skill = typeof inputRecord.skill === 'string' ? inputRecord.skill : '';
  if (isStreaming && !result && !skill) {
    return { action: 'Reading skill...' };
  }
  if (!result) {
    return { action: `Reading skill ${skill || ''}...`.trim() };
  }
  const path = skill ? `/home/claude/.claude/skills/${skill}/SKILL.md` : '';
  return {
    action: 'Read skill',
    filename: skill || 'skill',
    path: path || undefined,
  };
}
```

**Key insight:** Once `result` exists, lock into past tense ("Read skill X") regardless of `isStreaming`. This matches the status indicator behavior (green once complete) and prevents flip-flopping.

---

## Files to modify

1. `src/components/tool-call/tool-summary.ts` — all three fixes are in this single file

## Testing

Run `bun run test:run` after changes. If there are existing tests for `getToolSummaryParts`, verify they still pass and add cases for:
- Glob/Grep with a result that has no count match → should show "No files/matches found"
- Bash with `isStreaming=true`, input present, no result → should show "Running..."
- Bash with result → should show "Ran..."
- Skill with `result` present and `isStreaming=true` → should show "Read skill X" (past tense)
