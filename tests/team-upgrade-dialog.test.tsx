import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type React from "react"
import type { LegacyMigrationDialogData } from "@/components/billing/legacy-migration-dialog"

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn(),
}))

const fetcherSubmitMock = vi.fn()
const fetcherStateRef: { state: "idle" | "submitting"; data: unknown } = {
  state: "idle",
  data: undefined,
}

vi.mock("react-router", () => ({
  useFetcher: () => ({
    state: fetcherStateRef.state,
    data: fetcherStateRef.data,
    submit: fetcherSubmitMock,
  }),
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string
    children: React.ReactNode
  } & Record<string, unknown>) => (
    <a href={typeof to === "string" ? to : "#"} {...props}>
      {children}
    </a>
  ),
}))

vi.mock("sonner", () => ({
  toast: {
    error: toastErrorMock,
  },
}))

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}))

import { TeamUpgradeDialog } from "@/components/settings/team-upgrade-dialog"

function resetFetcher() {
  fetcherStateRef.state = "idle"
  fetcherStateRef.data = undefined
  fetcherSubmitMock.mockClear()
  toastErrorMock.mockClear()
}

function makeLegacyMigration(
  overrides: Partial<LegacyMigrationDialogData> = {},
): LegacyMigrationDialogData {
  return {
    eligible: true,
    customerId: "cus_test",
    activeLegacySubscriptionCount: 1,
    defaultPlan: "team",
    ...overrides,
  }
}

describe("TeamUpgradeDialog", () => {
  beforeEach(() => {
    resetFetcher()
  })

  afterEach(() => {
    resetFetcher()
  })

  it.each([
    ["free", "Your Free plan includes 1 seat."],
    ["starter", "Your Starter plan includes 1 seat."],
    ["pro", "Your Pro plan includes 1 seat."],
  ] as const)(
    "renders the description for the %s plan",
    (currentPlan, expected) => {
      render(
        <TeamUpgradeDialog
          open
          onOpenChange={vi.fn()}
          currentPlan={currentPlan}
          stripeConfigured
          legacyMigration={null}
        />,
      )

      expect(screen.getByText(new RegExp(expected))).toBeInTheDocument()
    },
  )

  it("submits to the billing changePlan action by default", () => {
    render(
      <TeamUpgradeDialog
        open
        onOpenChange={vi.fn()}
        currentPlan="pro"
        stripeConfigured
        legacyMigration={null}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /subscribe/i }))

    expect(fetcherSubmitMock).toHaveBeenCalledWith(
      { intent: "changePlan", plan: "team" },
      { method: "post", action: "/settings/organization/billing" },
    )
  })

  it("submits to the legacy-migration action when legacy migration is eligible", () => {
    render(
      <TeamUpgradeDialog
        open
        onOpenChange={vi.fn()}
        currentPlan="pro"
        stripeConfigured
        legacyMigration={makeLegacyMigration()}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /switch to team/i }))

    expect(fetcherSubmitMock).toHaveBeenCalledWith(
      { plan: "team" },
      { method: "post", action: "/api/billing/legacy-migration" },
    )
  })

  it("disables legacy migration when multiple active subscriptions need manual review", () => {
    render(
      <TeamUpgradeDialog
        open
        onOpenChange={vi.fn()}
        currentPlan="pro"
        stripeConfigured
        legacyMigration={makeLegacyMigration({
          activeLegacySubscriptionCount: 2,
        })}
      />,
    )

    expect(
      screen.getByText(/multiple active subscriptions/i),
    ).toBeInTheDocument()

    const cta = screen.getByRole("button", { name: /switch to team/i })
    expect(cta).toBeDisabled()

    fireEvent.click(cta)
    expect(fetcherSubmitMock).not.toHaveBeenCalled()
  })

  it("disables the CTA and the Compare plans button and renders helper text when Stripe is unconfigured", () => {
    render(
      <TeamUpgradeDialog
        open
        onOpenChange={vi.fn()}
        currentPlan="pro"
        stripeConfigured={false}
        legacyMigration={null}
      />,
    )

    expect(
      screen.getByText(/Hosted billing isn't configured in this environment/),
    ).toBeInTheDocument()

    const cta = screen.getByRole("button", { name: /subscribe/i })
    expect(cta).toBeDisabled()

    const compare = screen.getByRole("button", { name: /compare plans/i })
    expect(compare).toBeDisabled()
  })

  it("closes the dialog and redirects when the fetcher returns a checkoutUrl", () => {
    const onOpenChange = vi.fn()
    const assignMock = vi.fn()
    const originalLocation = window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignMock },
    })

    fetcherStateRef.state = "idle"
    fetcherStateRef.data = { checkoutUrl: "https://checkout.stripe.com/abc" }

    render(
      <TeamUpgradeDialog
        open
        onOpenChange={onOpenChange}
        currentPlan="free"
        stripeConfigured
        legacyMigration={null}
      />,
    )

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.com/abc")

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    })
  })

  it("redirects back to /settings/organization/team when the fetcher returns planChanged", () => {
    const onOpenChange = vi.fn()
    const assignMock = vi.fn()
    const originalLocation = window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignMock },
    })

    fetcherStateRef.state = "idle"
    fetcherStateRef.data = { planChanged: true }

    render(
      <TeamUpgradeDialog
        open
        onOpenChange={onOpenChange}
        currentPlan="pro"
        stripeConfigured
        legacyMigration={makeLegacyMigration()}
      />,
    )

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(assignMock).toHaveBeenCalledWith("/settings/organization/team")

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    })
  })

  it("redirects back to /settings/organization/team when legacy migration succeeds", () => {
    const onOpenChange = vi.fn()
    const assignMock = vi.fn()
    const originalLocation = window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignMock },
    })

    fetcherStateRef.state = "idle"
    fetcherStateRef.data = { success: true }

    render(
      <TeamUpgradeDialog
        open
        onOpenChange={onOpenChange}
        currentPlan="pro"
        stripeConfigured
        legacyMigration={makeLegacyMigration()}
      />,
    )

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(assignMock).toHaveBeenCalledWith("/settings/organization/team")

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    })
  })

  it("toasts the error message when the fetcher returns an error", () => {
    fetcherStateRef.state = "idle"
    fetcherStateRef.data = { error: "Something went wrong" }

    render(
      <TeamUpgradeDialog
        open
        onOpenChange={vi.fn()}
        currentPlan="pro"
        stripeConfigured
        legacyMigration={null}
      />,
    )

    expect(toastErrorMock).toHaveBeenCalledWith("Something went wrong")
  })

  it("does not redirect when the user cancelled mid-flight", () => {
    const onOpenChange = vi.fn()
    const assignMock = vi.fn()
    const originalLocation = window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignMock },
    })

    fetcherStateRef.state = "submitting"
    fetcherStateRef.data = undefined

    const { rerender } = render(
      <TeamUpgradeDialog
        open
        onOpenChange={onOpenChange}
        currentPlan="pro"
        stripeConfigured
        legacyMigration={null}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    fetcherStateRef.state = "idle"
    fetcherStateRef.data = { checkoutUrl: "https://checkout.stripe.com/abc" }
    rerender(
      <TeamUpgradeDialog
        open
        onOpenChange={onOpenChange}
        currentPlan="pro"
        stripeConfigured
        legacyMigration={null}
      />,
    )

    expect(assignMock).not.toHaveBeenCalled()

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    })
  })
})
