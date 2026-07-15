import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type React from "react"

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
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /subscribe/i }))

    expect(fetcherSubmitMock).toHaveBeenCalledWith(
      { intent: "changePlan", plan: "team" },
      { method: "post", action: "/settings/organization/billing" },
    )
  })

  it("disables the CTA and the Compare plans button and renders helper text when Stripe is unconfigured", () => {
    render(
      <TeamUpgradeDialog
        open
        onOpenChange={vi.fn()}
        currentPlan="pro"
        stripeConfigured={false}
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
      />,
    )

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(assignMock).toHaveBeenCalledWith("/settings/organization/team")

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    })
  })

  it("redirects back to /settings/organization/team when the update succeeds", () => {
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
      />,
    )

    expect(assignMock).not.toHaveBeenCalled()

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    })
  })
})
