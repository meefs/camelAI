import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("react-router", () => ({
  useFetcher: () => ({
    state: "idle",
    data: undefined,
    Form: "form",
  }),
}))

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}))

import { InviteMemberDialog } from "@/components/settings/invite-member-dialog"

describe("InviteMemberDialog", () => {
  it("shows the Team seat billing notice when enabled", () => {
    render(
      <InviteMemberDialog
        open={true}
        onOpenChange={vi.fn()}
        teamSeatBillingNotice={{
          coveredSeatCount: 3,
          nextSeatCount: 4,
          addedSeatCount: 1,
        }}
      />,
    )

    expect(screen.getByText("Billing seat will be added")).toBeInTheDocument()
    expect(
      screen.getByText(/Sending this invite increases billing from 3 to 4 Team seats/),
    ).toBeInTheDocument()
  })

  it("hides the Team seat billing notice by default", () => {
    render(<InviteMemberDialog open={true} onOpenChange={vi.fn()} />)

    expect(
      screen.queryByText("Billing seat will be added"),
    ).not.toBeInTheDocument()
  })
})
