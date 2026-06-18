import { describe, expect, it } from "vitest";
import {
  isConnectionsUiOnlySearchChange,
  shouldRevalidateConnectionsRoute,
} from "@/lib/connections-route-revalidation";

function url(value: string) {
  return new URL(value);
}

describe("connections route revalidation", () => {
  it("skips selected param changes", () => {
    expect(
      shouldRevalidateConnectionsRoute({
        currentUrl: url("https://camelai.dev/connections"),
        nextUrl: url("https://camelai.dev/connections?selected=conn_1"),
        defaultShouldRevalidate: true,
      }),
    ).toBe(false);

    expect(
      shouldRevalidateConnectionsRoute({
        currentUrl: url("https://camelai.dev/connections?selected=conn_1"),
        nextUrl: url("https://camelai.dev/connections?selected=conn_2"),
        defaultShouldRevalidate: true,
      }),
    ).toBe(false);

    expect(
      shouldRevalidateConnectionsRoute({
        currentUrl: url("https://camelai.dev/connections?selected=conn_1"),
        nextUrl: url("https://camelai.dev/connections"),
        defaultShouldRevalidate: true,
      }),
    ).toBe(false);
  });

  it("skips OAuth UI param changes and cleanup", () => {
    expect(
      isConnectionsUiOnlySearchChange(
        url("https://camelai.dev/connections?error=oauth_denied&reason=cancelled"),
        url("https://camelai.dev/connections"),
      ),
    ).toBe(true);

    expect(
      shouldRevalidateConnectionsRoute({
        currentUrl: url("https://camelai.dev/connections"),
        nextUrl: url("https://camelai.dev/connections?success=slack_connected"),
        defaultShouldRevalidate: true,
      }),
    ).toBe(false);
  });

  it("skips connection reauth param cleanup", () => {
    expect(
      shouldRevalidateConnectionsRoute({
        currentUrl: url(
          "https://camelai.dev/connections?connection=conn_1&reauth=1",
        ),
        nextUrl: url("https://camelai.dev/connections"),
        defaultShouldRevalidate: true,
      }),
    ).toBe(false);
  });

  it("preserves default same-path same-search explicit revalidation", () => {
    expect(
      shouldRevalidateConnectionsRoute({
        currentUrl: url("https://camelai.dev/connections?selected=conn_1"),
        nextUrl: url("https://camelai.dev/connections?selected=conn_1"),
        defaultShouldRevalidate: true,
      }),
    ).toBe(true);

    expect(
      shouldRevalidateConnectionsRoute({
        currentUrl: url("https://camelai.dev/connections?selected=conn_1"),
        nextUrl: url("https://camelai.dev/connections?selected=conn_1"),
        defaultShouldRevalidate: false,
      }),
    ).toBe(false);
  });

  it("preserves default for unknown search param changes", () => {
    expect(
      shouldRevalidateConnectionsRoute({
        currentUrl: url("https://camelai.dev/connections?selected=conn_1"),
        nextUrl: url(
          "https://camelai.dev/connections?selected=conn_1&filter=postgres",
        ),
        defaultShouldRevalidate: true,
      }),
    ).toBe(true);

    expect(
      shouldRevalidateConnectionsRoute({
        currentUrl: url("https://camelai.dev/connections?filter=postgres"),
        nextUrl: url("https://camelai.dev/connections?filter=database"),
        defaultShouldRevalidate: false,
      }),
    ).toBe(false);
  });

  it("revalidates pathname changes", () => {
    expect(
      shouldRevalidateConnectionsRoute({
        currentUrl: url("https://camelai.dev/connections?selected=conn_1"),
        nextUrl: url("https://camelai.dev/settings?selected=conn_1"),
        defaultShouldRevalidate: false,
      }),
    ).toBe(true);
  });

  it("preserves default for form submissions", () => {
    const formData = new FormData();
    formData.set("intent", "updateIntegration");

    expect(
      shouldRevalidateConnectionsRoute({
        currentUrl: url("https://camelai.dev/connections?selected=conn_1"),
        nextUrl: url("https://camelai.dev/connections?selected=conn_2"),
        formData,
        defaultShouldRevalidate: true,
      }),
    ).toBe(true);

    expect(
      shouldRevalidateConnectionsRoute({
        currentUrl: url("https://camelai.dev/connections?selected=conn_1"),
        nextUrl: url("https://camelai.dev/connections?selected=conn_2"),
        formData,
        defaultShouldRevalidate: false,
      }),
    ).toBe(false);
  });
});
