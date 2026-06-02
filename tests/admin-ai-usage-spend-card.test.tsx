import { fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-router", () => ({
  redirect: vi.fn((url: string) => new Response(null, {
    status: 302,
    headers: { Location: url },
  })),
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: React.ReactNode;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  Form: ({ children, ...props }: React.ComponentProps<"form">) => (
    <form {...props}>{children}</form>
  ),
  useFetcher: () => ({
    state: "idle",
    data: null,
    Form: ({ children, ...props }: React.ComponentProps<"form">) => (
      <form {...props}>{children}</form>
    ),
  }),
  useLoaderData: vi.fn(),
}));

vi.mock("@/lib/auth.server", () => ({
  requireSuperuser: vi.fn(),
  getAuthEnv: vi.fn(),
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: vi.fn(),
}));

vi.mock("@/lib/wait-until", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/lib/auth-do", () => ({
  adminTransferOrgOwnership: vi.fn(),
  updateOrgMemberRole: vi.fn(),
  getOrg: vi.fn(),
  getOrgMembers: vi.fn(),
  getOrgInvitations: vi.fn(),
}));

vi.mock("@/lib/auth-do.server", () => ({
  addAdminOrgMember: vi.fn(),
  adminGetWorkspacesByOrg: vi.fn(),
  adminGetOrgRecentActivity: vi.fn(),
  hardDeleteAdminOrg: vi.fn(),
  runAdminOrgBanAndPurgeWithEnv: vi.fn(),
  startAdminOrgBanAndPurgeWithEnv: vi.fn(),
}));

vi.mock("../workers/main/src/ban-list", () => ({
  getOrgBanById: vi.fn(),
}));

vi.mock("@/lib/admin-custom-domain.server", () => ({
  refreshOrgCustomDomainHostnamesForAdmin: vi.fn(),
}));

vi.mock("@/components/admin/admin-page-header", () => ({
  AdminPageHeader: () => null,
}));

vi.mock("@/components/admin/add-org-member-dialog", () => ({
  AddOrgMemberDialog: () => null,
}));

vi.mock("@/components/admin/org-danger-zone", () => ({
  OrgDangerZone: () => null,
}));

vi.mock("@/components/admin/org-member-role-select", () => ({
  OrgMemberRoleSelect: () => null,
}));

vi.mock("@/components/admin/org-edit-form", () => ({
  OrgEditForm: () => null,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const { AdminAiUsageSpendCard } = await import("@/routes/_admin.orgs.$id");

const baseProps = {
  orgId: "org_123",
  usageSpend: {
    org_id: "org_123",
    total_cost_usd: 12.34,
    total_requests: 7,
    windows: [],
  },
  usageLog: {
    entries: [
      {
        id: 1,
        model: "claude-sonnet-20260101",
        provider: "anthropic",
        input_tokens: 1000,
        output_tokens: 250,
        cost_usd: 0.1234,
        duration_ms: 1200,
        created_at_ms: 1710000000000,
      },
    ],
  },
  creditSummary: {
    purchaseTotalCents: 5000,
    grantTotalCents: 2500,
    totalCreditLimitCents: 7500,
    chargeableUsageCents: 1234,
    availableCreditsCents: 6266,
  },
  creditGrants: [
    {
      grant_id: "grant_1",
      amount_cents: 500,
      reason: "Low-credit alert testing",
      created_at: 1710000010000,
      created_by: "user_super",
      source: "qaml-backdoor",
    },
  ],
  creditGrantsUnavailable: false,
  creditGrantsError: null,
  creditGrantUsers: [
    {
      id: "user_super",
      email: "super@example.com",
      name: "Super User",
    },
  ],
};

describe("AdminAiUsageSpendCard", () => {
  it("opens the grant dialog and renders credit grant rows", () => {
    render(<AdminAiUsageSpendCard {...baseProps} />);

    expect(screen.getByText("$62.66")).toBeInTheDocument();
    expect(screen.getByText("$5.00")).toBeInTheDocument();
    expect(screen.getByText("Low-credit alert testing")).toBeInTheDocument();
    expect(screen.getByText("Super User")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Grant credits" }));

    expect(screen.getByText("Grant usage credits")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("5.00")).toBeInTheDocument();
  });

  it("distinguishes empty and unavailable credit grant states", () => {
    const { rerender } = render(
      <AdminAiUsageSpendCard
        {...baseProps}
        creditGrants={[]}
        creditGrantUsers={[]}
      />,
    );

    expect(screen.getByText("No credit grants recorded")).toBeInTheDocument();

    rerender(
      <AdminAiUsageSpendCard
        {...baseProps}
        creditGrants={[]}
        creditGrantsUnavailable
        creditGrantsError="ledger offline"
        creditGrantUsers={[]}
      />,
    );

    expect(
      screen.getByText("Credit grant history unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText("ledger offline")).toBeInTheDocument();
    expect(screen.queryByText("No credit grants recorded")).not.toBeInTheDocument();
  });
});
