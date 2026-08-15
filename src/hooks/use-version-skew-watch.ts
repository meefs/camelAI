"use client";

import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import {
  checkForVersionSkew,
  isReloadSafeNow,
  type VersionSkewTrigger,
} from "@/lib/version-skew";

/**
 * Generic backstop for routes that register no guard of their own: a silent
 * reload must never eat text a user is in the middle of entering. Chat's guard
 * is precise (draft, attachments, in-flight turn); everywhere else this DOM
 * scan is the conservative substitute, and it fails toward "prompt instead of
 * reload", which still heals the tab.
 */
export function documentHoldsUnsavedInput(): boolean {
  if (typeof document === "undefined") return false;
  // An open modal is a task in progress (checkout, rename, confirm): reloading
  // it away is exactly the kind of surprise this guard exists to prevent.
  if (document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')) {
    return true;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.isContentEditable) {
    if ((active.textContent ?? "").trim() !== "") return true;
  }
  for (const field of document.querySelectorAll("input, textarea")) {
    if (
      field instanceof HTMLInputElement &&
      // Only free-text entry can hold work in progress; a checkbox or a hidden
      // field is either persisted already or not user-entered at all.
      !["text", "email", "password", "search", "tel", "url", "number"].includes(
        field.type,
      )
    ) {
      continue;
    }
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
      continue;
    }
    if (field.disabled || field.readOnly) continue;
    if (field.value.trim() !== "") return true;
  }
  return false;
}

/**
 * App-shell version-skew watcher.
 *
 * Mounted by ChatGroupsProvider (src/routes/_app.tsx wraps every non-embed
 * page), so the "is this tab running a retired bundle?" check covers settings,
 * connections and the workspace list — not just an open chat thread. That gap
 * is what let a stale tab sit in a permanent transport-failure loop after a
 * transport removal with nothing to heal it.
 *
 * Reload safety is global (`isReloadSafeNow`): Chat registers a guard for its
 * draft/in-flight-turn state, and a route that registers none is by definition
 * safe to reload silently.
 *
 * Returns a runner so a transport can report its own wake-up moments
 * (`status_stream_error`) in addition to the visibility trigger wired here.
 */
export function useVersionSkewWatch(): (trigger: VersionSkewTrigger) => void {
  const runVersionSkewCheck = useCallback((trigger: VersionSkewTrigger) => {
    void checkForVersionSkew({
      trigger,
      safeToReload: () => isReloadSafeNow() && !documentHoldsUnsavedInput(),
      // Same toast id as the chat-route prompt: at most one "update available"
      // toast per tab, whichever trigger noticed first.
      onUpdateAvailable: (reload) => {
        toast("camelAI has been updated", {
          id: "camelai-version-skew",
          description: "Reload to get the latest version.",
          duration: 60_000,
          action: { label: "Reload", onClick: reload },
        });
      },
    });
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        runVersionSkewCheck("visibility");
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [runVersionSkewCheck]);

  return runVersionSkewCheck;
}
