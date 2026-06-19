import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

type LegacyMigration = {
  eligible: boolean;
  customerId: string;
  activeLegacySubscriptionCount: number;
  defaultPlan: "starter" | "pro" | "team";
};

const testState = vi.hoisted(() => ({
  loaderData: { current: undefined as unknown },
  navigate: vi.fn(),
  revalidate: vi.fn(),
  revalidatorState: "idle" as "idle" | "loading" | "submitting",
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();

  return {
    ...actual,
    Outlet: () => <div data-testid="outlet" />,
    useLoaderData: () => testState.loaderData.current,
    useNavigate: () => testState.navigate,
    useRevalidator: () => ({
      revalidate: testState.revalidate,
      state: testState.revalidatorState,
    }),
  };
});

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: vi.fn(),
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: vi.fn(),
}));

vi.mock("@/lib/cookies.server", () => ({
  parseCookies: vi.fn(() => ({})),
  createSessionCookieHeader: vi.fn(() => "session=mock"),
}));

vi.mock("@/lib/billing.server", () => ({
  getVerifiedLegacyStripeMigrationEligibility: vi.fn(() => null),
  hasOrgUsedSubscriptionTrial: vi.fn(() => false),
}));

vi.mock("@/components/sidebar/app-sidebar", () => ({
  AppSidebar: () => <div data-testid="app-sidebar" />,
}));

vi.mock("@/hooks/use-chat-groups", () => ({
  ChatGroupsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/legacy-user-banner", () => ({
  LegacyUserBanner: () => <div data-testid="legacy-user-banner" />,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="sidebar-provider">{children}</div>
  ),
  SidebarInset: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
}));

vi.mock("@/components/billing/legacy-migration-dialog", () => ({
  LegacyMigrationDialog: ({
    migration,
    open,
    onOpenChange,
    primaryAction,
  }: {
    migration: LegacyMigration | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    primaryAction?: { label?: string; onClick: () => void };
  }) => (
    <section
      data-testid="legacy-migration-dialog"
      data-eligible={String(Boolean(migration?.eligible))}
      data-open={String(open)}
    >
      {open && migration?.eligible ? (
        <>
          <button type="button" onClick={() => onOpenChange(false)}>
            Dismiss migration
          </button>
          <button type="button" onClick={primaryAction?.onClick}>
            {primaryAction?.label ?? "See plans"}
          </button>
        </>
      ) : null}
    </section>
  ),
}));

vi.mock("@/components/billing/paywall-takeover", () => ({
  PaywallTakeover: () => <div data-testid="paywall-takeover" />,
}));

const { default: AppLayout } = await import("@/routes/_app");

function makeMigration(overrides: Partial<LegacyMigration> = {}): LegacyMigration {
  return {
    eligible: true,
    customerId: "cus_123",
    activeLegacySubscriptionCount: 1,
    defaultPlan: "pro",
    ...overrides,
  };
}

function makeLoaderData({
  orgId,
  legacyMigration,
  billingAccessReady = true,
  appRouteAccessible = billingAccessReady,
}: {
  orgId: string;
  legacyMigration: LegacyMigration | null;
  billingAccessReady?: boolean;
  appRouteAccessible?: boolean;
}) {
  return {
    authState: {
      user: { id: "user_123" },
      currentOrg: { id: orgId, name: orgId },
      currentWorkspace: null,
      orgs: [],
      onboarding: { completed_at: 1 },
      workspaces: [],
      allWorkspaces: [],
      orgWorkspaceCount: 0,
      loading: false,
      error: null,
    },
    defaultSidebarOpen: true,
    showLegacyBanner: false,
    legacyMigration,
    billingAccessReady,
    appRouteAccessible,
    paywallContext: billingAccessReady
      ? null
      : {
          currentOrgName: orgId,
          multiOrg: true,
          byokProviderLabel: null,
        },
  };
}

describe("AppLayout legacy migration disclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    testState.revalidatorState = "idle";
    testState.loaderData.current = makeLoaderData({
      orgId: "org_free",
      legacyMigration: null,
    });
  });

  it("opens the disclosure when refreshed loader data becomes eligible", async () => {
    const { rerender } = render(<AppLayout />);

    expect(screen.getByTestId("legacy-migration-dialog")).toHaveAttribute(
      "data-open",
      "false",
    );

    testState.loaderData.current = makeLoaderData({
      orgId: "org_legacy",
      legacyMigration: makeMigration(),
    });
    rerender(<AppLayout />);

    await waitFor(() => {
      expect(screen.getByTestId("legacy-migration-dialog")).toHaveAttribute(
        "data-open",
        "true",
      );
    });
  });

  it("keeps a same-org dismissal closed across loader revalidation", async () => {
    const user = userEvent.setup();
    testState.loaderData.current = makeLoaderData({
      orgId: "org_legacy",
      legacyMigration: makeMigration(),
    });
    const { rerender } = render(<AppLayout />);

    expect(screen.getByTestId("legacy-migration-dialog")).toHaveAttribute(
      "data-open",
      "true",
    );
    await user.click(screen.getByRole("button", { name: /dismiss migration/i }));
    expect(screen.getByTestId("legacy-migration-dialog")).toHaveAttribute(
      "data-open",
      "false",
    );

    testState.loaderData.current = makeLoaderData({
      orgId: "org_legacy",
      legacyMigration: makeMigration(),
    });
    rerender(<AppLayout />);

    expect(screen.getByTestId("legacy-migration-dialog")).toHaveAttribute(
      "data-open",
      "false",
    );
  });

  it("reopens for a different eligible organization", async () => {
    const user = userEvent.setup();
    testState.loaderData.current = makeLoaderData({
      orgId: "org_legacy_a",
      legacyMigration: makeMigration({ customerId: "cus_a" }),
    });
    const { rerender } = render(<AppLayout />);

    await user.click(screen.getByRole("button", { name: /dismiss migration/i }));
    expect(screen.getByTestId("legacy-migration-dialog")).toHaveAttribute(
      "data-open",
      "false",
    );

    testState.loaderData.current = makeLoaderData({
      orgId: "org_legacy_b",
      legacyMigration: makeMigration({ customerId: "cus_b" }),
    });
    rerender(<AppLayout />);

    await waitFor(() => {
      expect(screen.getByTestId("legacy-migration-dialog")).toHaveAttribute(
        "data-open",
        "true",
      );
    });
  });

  it("routes the primary action directly to the billing plan picker", async () => {
    const user = userEvent.setup();
    testState.loaderData.current = makeLoaderData({
      orgId: "org_legacy",
      legacyMigration: makeMigration(),
    });
    render(<AppLayout />);

    await user.click(screen.getByRole("button", { name: /see plans/i }));

    expect(testState.navigate).toHaveBeenCalledWith(
      "/settings/organization/billing?view=plans",
    );
  });

  it("renders the paywall takeover and suppresses the floating migration dialog without billing access", () => {
    testState.loaderData.current = makeLoaderData({
      orgId: "org_legacy",
      legacyMigration: makeMigration(),
      billingAccessReady: false,
    });
    render(<AppLayout />);

    expect(screen.getByTestId("paywall-takeover")).toBeInTheDocument();
    expect(screen.queryByTestId("outlet")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("legacy-migration-dialog"),
    ).not.toBeInTheDocument();
  });

});
