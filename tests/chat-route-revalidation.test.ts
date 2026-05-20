import { describe, expect, it } from "vitest";
import { shouldRevalidateActiveChatRoute } from "@/lib/chat-route-revalidation";

function url(value: string) {
  return new URL(value);
}

describe("active chat route revalidation", () => {
  it("preserves default same-thread same-URL revalidation", () => {
    expect(
      shouldRevalidateActiveChatRoute({
        currentUrl: url("https://camelai.dev/chat/thread_1?group=group_1"),
        nextUrl: url("https://camelai.dev/chat/thread_1?group=group_1"),
        currentParams: { id: "thread_1" },
        nextParams: { id: "thread_1" },
        defaultShouldRevalidate: true,
      }),
    ).toBe(true);
  });

  it("preserves default same-thread same-URL revalidation skips", () => {
    expect(
      shouldRevalidateActiveChatRoute({
        currentUrl: url("https://camelai.dev/chat/thread_1?group=group_1"),
        nextUrl: url("https://camelai.dev/chat/thread_1?group=group_1"),
        currentParams: { id: "thread_1" },
        nextParams: { id: "thread_1" },
        defaultShouldRevalidate: false,
      }),
    ).toBe(false);
  });

  it("revalidates when the thread id changes", () => {
    expect(
      shouldRevalidateActiveChatRoute({
        currentUrl: url("https://camelai.dev/chat/thread_1?group=group_1"),
        nextUrl: url("https://camelai.dev/chat/thread_2?group=group_1"),
        currentParams: { id: "thread_1" },
        nextParams: { id: "thread_2" },
        defaultShouldRevalidate: true,
      }),
    ).toBe(true);
  });

  it("revalidates thread changes even when the router default is false", () => {
    expect(
      shouldRevalidateActiveChatRoute({
        currentUrl: url("https://camelai.dev/chat/thread_1?group=group_1"),
        nextUrl: url("https://camelai.dev/chat/thread_2?group=group_1"),
        currentParams: { id: "thread_1" },
        nextParams: { id: "thread_2" },
        defaultShouldRevalidate: false,
      }),
    ).toBe(true);
  });

  it("revalidates when loader-affecting search params change", () => {
    expect(
      shouldRevalidateActiveChatRoute({
        currentUrl: url("https://camelai.dev/chat/thread_1?group=group_1"),
        nextUrl: url("https://camelai.dev/chat/thread_1?group=group_2"),
        currentParams: { id: "thread_1" },
        nextParams: { id: "thread_1" },
        defaultShouldRevalidate: true,
      }),
    ).toBe(true);
  });

  it("revalidates loader-affecting search changes even when the router default is false", () => {
    expect(
      shouldRevalidateActiveChatRoute({
        currentUrl: url("https://camelai.dev/chat/thread_1?group=group_1"),
        nextUrl: url("https://camelai.dev/chat/thread_1?group=group_2"),
        currentParams: { id: "thread_1" },
        nextParams: { id: "thread_1" },
        defaultShouldRevalidate: false,
      }),
    ).toBe(true);
  });

  it("treats dev loader controls as loader-affecting search params", () => {
    expect(
      shouldRevalidateActiveChatRoute({
        currentUrl: url("https://camelai.dev/chat/thread_1?devCreditState=ok"),
        nextUrl: url("https://camelai.dev/chat/thread_1?devCreditState=exhausted"),
        currentParams: { id: "thread_1" },
        nextParams: { id: "thread_1" },
        defaultShouldRevalidate: false,
      }),
    ).toBe(true);
  });

  it("skips updateThreadModel action revalidation", () => {
    const formData = new FormData();
    formData.set("intent", "updateThreadModel");

    expect(
      shouldRevalidateActiveChatRoute({
        currentUrl: url("https://camelai.dev/chat/thread_1"),
        nextUrl: url("https://camelai.dev/chat/thread_1"),
        currentParams: { id: "thread_1" },
        nextParams: { id: "thread_1" },
        formData,
        defaultShouldRevalidate: true,
      }),
    ).toBe(false);
  });

  it("still revalidates updateThreadModel submissions when the thread changes", () => {
    const formData = new FormData();
    formData.set("intent", "updateThreadModel");

    expect(
      shouldRevalidateActiveChatRoute({
        currentUrl: url("https://camelai.dev/chat/thread_1"),
        nextUrl: url("https://camelai.dev/chat/thread_2"),
        currentParams: { id: "thread_1" },
        nextParams: { id: "thread_2" },
        formData,
        defaultShouldRevalidate: true,
      }),
    ).toBe(true);
  });
});
