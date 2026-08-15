/**
 * App-shell version-skew watcher: the piece that lets a stale tab on a NON-chat
 * route (settings, connections, workspace list) notice it is running a retired
 * bundle. Before this, `checkForVersionSkew` was wired only inside Chat.tsx, so
 * exactly the cohort with no chat open — and therefore no self-heal — was the
 * one left reconnect-looping after a transport removal.
 */
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  documentHoldsUnsavedInput,
  useVersionSkewWatch,
} from "@/hooks/use-version-skew-watch";
import { resetVersionSkewStateForTests } from "@/lib/version-skew";

vi.mock("@/lib/app-build-id", () => ({ APP_BUILD_ID: "build-old" }));

const toastCalls: unknown[] = [];
vi.mock("sonner", () => ({
  toast: Object.assign(
    (...args: unknown[]) => {
      toastCalls.push(args);
    },
    { error: () => {}, success: () => {} },
  ),
}));

function Watcher() {
  useVersionSkewWatch();
  return null;
}

function stubReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn();
  const original = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: Object.assign(Object.create(Object.getPrototypeOf(original)), {
      ...original,
      reload,
    }),
  });
  return reload;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useVersionSkewWatch", () => {
  beforeEach(() => {
    toastCalls.length = 0;
    resetVersionSkewStateForTests();
    window.sessionStorage.clear();
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      writable: true,
      value: () => true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input) === "/api/version"
          ? Response.json({ buildId: "build-new" })
          : new Response(null, { status: 204 }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("reloads a stale tab when it becomes visible, with no chat mounted", async () => {
    const reload = stubReload();
    render(<Watcher />);

    setVisibility("visible");

    await waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });

  it("prompts instead of reloading while a text field holds input", async () => {
    const reload = stubReload();
    const input = document.createElement("input");
    input.type = "text";
    input.value = "half-written workspace name";
    document.body.appendChild(input);
    render(<Watcher />);

    setVisibility("visible");

    await waitFor(() => {
      expect(toastCalls).toHaveLength(1);
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("stops checking once unmounted", async () => {
    const reload = stubReload();
    const { unmount } = render(<Watcher />);
    unmount();

    setVisibility("visible");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(reload).not.toHaveBeenCalled();
  });
});

describe("documentHoldsUnsavedInput", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("ignores empty, disabled, readonly and non-text fields", () => {
    document.body.innerHTML = `
      <input type="text" value="" />
      <input type="text" value="typed" disabled />
      <input type="text" value="typed" readonly />
      <input type="checkbox" checked />
      <input type="hidden" value="csrf-token" />
      <textarea></textarea>
    `;
    expect(documentHoldsUnsavedInput()).toBe(false);
  });

  it("treats an open modal as unsafe", () => {
    document.body.innerHTML = `<div role="dialog">Confirm purchase</div>`;
    expect(documentHoldsUnsavedInput()).toBe(true);
  });

  it("detects a non-empty textarea", () => {
    document.body.innerHTML = `<textarea>draft</textarea>`;
    const textarea = document.querySelector("textarea")!;
    textarea.value = "draft";
    expect(documentHoldsUnsavedInput()).toBe(true);
  });
});
