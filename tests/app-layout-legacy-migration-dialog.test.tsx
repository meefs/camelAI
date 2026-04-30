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
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();

  return {
    ...actual,
    Outlet: () => <div data-testid="outlet" />,
    useLoaderData: () => testState.loaderData.current,
    useNavigate: () => testState.navigate,
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
  getLegacyStripeMigrationEligibility: vi.fn(() => null),
  isConfiguredEnterpriseOrg: vi.fn(() => false),
}));

vi.mock("@/components/sidebar/app-sidebar", () => ({
  AppSidebar: () => <div data-testid="app-sidebar" />,
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
}: {
  orgId: string;
  legacyMigration: LegacyMigration | null;
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
  };
}

describe("AppLayout legacy migration disclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
