# Skill Sheet Implementation Feedback

## Status: One Critical Fix Missing

Most of the implementation is correct. The only missing piece is in the WebSocket event handler in `Chat.tsx`.

---

## What Was Implemented Correctly

| File | Status |
|------|--------|
| `src/types.ts` | Added `isMeta` and `sourceToolUseID` to Message type |
| `src/components/message-bubble.tsx` | Added `isMeta` check (line 188-190) and `skillSheets` prop |
| `src/components/tool-call/tool-call.tsx` | Added `skillSheet` prop (line 18, 75, 114) |
| `src/components/tool-call/tool-details.tsx` | Added `Skill` case and `skillSheet` prop |
| `src/components/tool-call/details/skill-details.tsx` | Created with expand/collapse UI |
| `src/components/tool-call/tool-summary.ts` | Added `Skill` case (lines 125-134) |
| `src/components/Chat.tsx` line 135-138 | Added `visibleMessages` filter |
| `src/components/Chat.tsx` line 177-192 | Added `skillSheetsByToolId` useMemo |
| `src/components/Chat.tsx` line 1245 | Passing `skillSheets` to MessageBubble |

---

## The Missing Fix

### Problem Location

**File:** `src/components/Chat.tsx`
**Lines:** 569-578

### Current Code (Bug)

```typescript
} else if (sdkEvent.type === 'user' && sdkEvent.message?.content) {
  // Append user content blocks (tool_result) to current streaming message
  const msgId = streamingMessageIdRef.current;
  if (msgId) {
    setMessages(prev => prev.map(msg => {
      if (msg.id !== msgId) return msg;
      const content = Array.isArray(msg.content) ? msg.content : [];
      return { ...msg, content: [...content, ...sdkEvent.message!.content] };
    }));
  }
}
```

### Why This Is Wrong

The code appends ALL `user` type sdk_events to the streaming assistant message's content array. This includes:
- `tool_result` blocks (correct - should be appended)
- Skill sheet meta messages (WRONG - should NOT be appended)

The skill sheet comes as:
```json
{
  "type": "user",
  "message": { "content": [{ "type": "text", "text": "...skill sheet..." }] },
  "isMeta": true,
  "sourceToolUseID": "toolu_..."
}
```

### Why Existing Fixes Don't Help

- `visibleMessages` filter (line 135-138) - Filters the message ARRAY, but skill sheet is appended to a message's CONTENT array
- `skillSheetsByToolId` useMemo (line 177-192) - Only extracts from persisted messages, not streaming events
- `MessageBubble.isMeta` check (line 188-190) - The skill sheet isn't a separate message during streaming

---

## Required Fix

### Replace lines 569-578 with:

```typescript
} else if (sdkEvent.type === 'user' && sdkEvent.message?.content) {
  // Check if this is a meta message (e.g., skill sheet)
  const isMeta = (sdkEvent as { isMeta?: boolean }).isMeta;
  const sourceToolUseID = (sdkEvent as { sourceToolUseID?: string }).sourceToolUseID;

  if (isMeta && sourceToolUseID) {
    // This is a skill sheet - add as a separate message with isMeta flag
    // It will be filtered from display by visibleMessages and extracted by skillSheetsByToolId
    const metaMsg: Message = {
      id: `meta_${sourceToolUseID}_${Date.now()}`,
      thread_id: threadId || '',
      role: 'user',
      content: sdkEvent.message!.content,
      created_at: Date.now(),
      isMeta: true,
      sourceToolUseID: sourceToolUseID,
    };
    setMessages(prev => [...prev, metaMsg]);
  } else {
    // Regular user content (tool_result) - append to streaming message
    const msgId = streamingMessageIdRef.current;
    if (msgId) {
      setMessages(prev => prev.map(msg => {
        if (msg.id !== msgId) return msg;
        const content = Array.isArray(msg.content) ? msg.content : [];
        return { ...msg, content: [...content, ...sdkEvent.message!.content] };
      }));
    }
  }
}
```

### Why This Works

1. When a skill sheet arrives (detected by `isMeta: true`), we create a SEPARATE message with the `isMeta` and `sourceToolUseID` flags
2. This message is automatically:
   - Filtered out of display by `visibleMessages` (line 135-138)
   - Extracted by `skillSheetsByToolId` (line 177-192)
   - Available to the Skill tool call via the `skillSheets` prop
3. Regular tool_result events continue to be appended to the streaming message as before

---

## Verification Checklist

After implementing the fix:

- [ ] **During streaming:** Skill sheet text does NOT appear in the assistant message
- [ ] **During streaming:** Tool call shows "• Activated frontend-design" with green dot
- [ ] **During streaming:** Expanding the tool call shows the skill sheet content
- [ ] **After page refresh:** Skill sheet does NOT appear as a user message bubble
- [ ] **After page refresh:** Tool call can still be expanded to see skill sheet

---

## Diff Summary

```diff
--- a/src/components/Chat.tsx
+++ b/src/components/Chat.tsx
@@ -566,14 +566,29 @@ export default function Chat(...) {
             }
           }
         } else if (sdkEvent.type === 'user' && sdkEvent.message?.content) {
-          // Append user content blocks (tool_result) to current streaming message
-          const msgId = streamingMessageIdRef.current;
-          if (msgId) {
-            setMessages(prev => prev.map(msg => {
-              if (msg.id !== msgId) return msg;
-              const content = Array.isArray(msg.content) ? msg.content : [];
-              return { ...msg, content: [...content, ...sdkEvent.message!.content] };
-            }));
+          // Check if this is a meta message (e.g., skill sheet)
+          const isMeta = (sdkEvent as { isMeta?: boolean }).isMeta;
+          const sourceToolUseID = (sdkEvent as { sourceToolUseID?: string }).sourceToolUseID;
+
+          if (isMeta && sourceToolUseID) {
+            // This is a skill sheet - add as a separate message with isMeta flag
+            const metaMsg: Message = {
+              id: `meta_${sourceToolUseID}_${Date.now()}`,
+              thread_id: threadId || '',
+              role: 'user',
+              content: sdkEvent.message!.content,
+              created_at: Date.now(),
+              isMeta: true,
+              sourceToolUseID: sourceToolUseID,
+            };
+            setMessages(prev => [...prev, metaMsg]);
+          } else {
+            // Regular user content (tool_result) - append to streaming message
+            const msgId = streamingMessageIdRef.current;
+            if (msgId) {
+              setMessages(prev => prev.map(msg => {
+                if (msg.id !== msgId) return msg;
+                const content = Array.isArray(msg.content) ? msg.content : [];
+                return { ...msg, content: [...content, ...sdkEvent.message!.content] };
+              }));
+            }
           }
         } else if (sdkEvent.type === 'result') {
```

This is the only change needed. All other components are already correctly implemented.
