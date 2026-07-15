import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const fetcherMock = vi.hoisted(() => ({
  state: "idle",
  data: undefined as unknown,
  submit: vi.fn(),
}))

vi.mock("react-router", () => ({
  useFetcher: () => ({
    state: fetcherMock.state,
    data: fetcherMock.data,
    submit: fetcherMock.submit,
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
import { toast } from "sonner"

describe("InviteMemberDialog", () => {
  beforeEach(() => {
    fetcherMock.state = "idle"
    fetcherMock.data = undefined
    vi.clearAllMocks()
  })

  it("requires a separate Stripe capacity purchase when invites exceed paid seats", async () => {
    const user = userEvent.setup()
    render(
      <InviteMemberDialog
        open={true}
        onOpenChange={vi.fn()}
        teamInviteBillingContext={{
          occupiedSeatCount: 3,
          coveredSeatCount: 3,
          unitMonthlyAmountCents: 5000,
          minimumSeats: 3,
          syncable: true,
        }}
      />,
    )

    await user.type(screen.getByPlaceholderText("Type or paste emails..."), "ana@example.com{enter}")

    expect(screen.getByText("Buy 1 more seat first")).toBeInTheDocument()
    expect(screen.getByText(/You have 3 paid seats/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Buy 1 seat in Stripe" }))
    expect(fetcherMock.submit).toHaveBeenCalledWith(
      { intent: "buyTeamCapacity", requestedInviteCount: "1" },
      { method: "post" },
    )
    expect(
      screen.getAllByRole("button", { name: "Send invite" }).every(
        (button) => button.hasAttribute("disabled"),
      ),
    ).toBe(true)
  })

  it("hides the Team seat billing notice by default", () => {
    render(<InviteMemberDialog open={true} onOpenChange={vi.fn()} />)

    expect(
      screen.queryByText("Buy 1 more seat first"),
    ).not.toBeInTheDocument()
  })

  it("allows invites during paused billing when paid seats already cover them", async () => {
    const user = userEvent.setup()
    render(
      <InviteMemberDialog
        open={true}
        onOpenChange={vi.fn()}
        teamInviteBillingContext={{
          occupiedSeatCount: 2,
          coveredSeatCount: 3,
          unitMonthlyAmountCents: 5000,
          minimumSeats: 3,
          syncable: false,
        }}
      />,
    )

    await user.type(screen.getByPlaceholderText("Type or paste emails..."), "ana@example.com{enter}")

    expect(screen.getByText("Seats available")).toBeInTheDocument()
    expect(screen.queryByText("Subscription needs attention")).not.toBeInTheDocument()
    expect(
      screen.getAllByRole("button", { name: "Send invite" }).every((button) => !button.hasAttribute("disabled")),
    ).toBe(true)
  })

  it("blocks invites during paused billing when they would add paid seats", async () => {
    const user = userEvent.setup()
    render(
      <InviteMemberDialog
        open={true}
        onOpenChange={vi.fn()}
        teamInviteBillingContext={{
          occupiedSeatCount: 3,
          coveredSeatCount: 3,
          unitMonthlyAmountCents: 5000,
          minimumSeats: 3,
          syncable: false,
        }}
      />,
    )

    await user.type(screen.getByPlaceholderText("Type or paste emails..."), "ana@example.com{enter}")

    expect(screen.getByText("Subscription needs attention")).toBeInTheDocument()
    expect(
      screen.getAllByRole("button", { name: "Send invite" }).every((button) => button.hasAttribute("disabled")),
    ).toBe(true)
  })

  it("renders pasted valid emails as chips and rejects invalid tokens", async () => {
    render(<InviteMemberDialog open={true} onOpenChange={vi.fn()} />)

    const input = screen.getByPlaceholderText("Type or paste emails...")
    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "ana@example.com nope ben@example.com",
      },
    })

    expect(await screen.findByText("ana@example.com")).toBeInTheDocument()
    expect(screen.getByText("ben@example.com")).toBeInTheDocument()
    expect(screen.queryByText("nope")).not.toBeInTheDocument()
  })

  it("submits duplicate valid emails once", async () => {
    const user = userEvent.setup()
    render(<InviteMemberDialog open={true} onOpenChange={vi.fn()} />)

    await user.type(
      screen.getByPlaceholderText("Type or paste emails..."),
      "ana@example.com ana@example.com{enter}",
    )

    await waitFor(() => {
      expect(screen.getAllByDisplayValue("ana@example.com")).toHaveLength(1)
    })
  })

  it("uses an atomic server capacity conflict to refresh the buy-seats state", async () => {
    const user = userEvent.setup()
    const dialogProps = {
      open: true,
      onOpenChange: vi.fn(),
      teamInviteBillingContext: {
        occupiedSeatCount: 3,
        coveredSeatCount: 3,
        unitMonthlyAmountCents: 5000,
        minimumSeats: 3,
        syncable: true,
      },
    }
    const view = render(<InviteMemberDialog {...dialogProps} />)

    await user.type(
      screen.getByPlaceholderText("Type or paste emails..."),
      "ana@example.com{enter}",
    )

    fetcherMock.data = {
      success: false,
      error: "insufficient_paid_seats",
      billing: {
        coveredSeatCount: 3,
        occupiedSeatCount: 4,
        requestedInviteCount: 1,
        nextSeatCount: 5,
        addedSeatCount: 2,
        addedMonthlyAmountCents: 10000,
      },
    }
    view.rerender(<InviteMemberDialog {...dialogProps} />)

    expect(await screen.findByText("Buy 2 more seats first")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Buy 2 seats in Stripe" }),
    ).toBeInTheDocument()
  })
  it("closes after invitations are created even when email delivery fails", () => {
    const onOpenChange = vi.fn()
    fetcherMock.data = {
      success: true,
      invited: [
        { email: "ana@example.com", invitation_id: "inv_1" },
        { email: "ben@example.com", invitation_id: "inv_2" },
      ],
      skipped: [],
      failed: [
        { email: "ana@example.com", reason: "email_delivery_failed" },
        { email: "ben@example.com", reason: "Cloudflare Email Sending binding EMAIL is not configured" },
      ],
    }

    render(<InviteMemberDialog open={true} onOpenChange={onOpenChange} />)

    expect(toast.warning).toHaveBeenCalledWith(
      "Created 2 invitations, but 2 emails could not be delivered. You can copy invite links from the team table.",
      {
        description:
          "ana@example.com: couldn't deliver email\nben@example.com: email delivery is not configured",
      },
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("closes after fully successful bulk invites", () => {
    const onOpenChange = vi.fn()
    fetcherMock.data = {
      success: true,
      invited: [
        { email: "ana@example.com", invitation_id: "inv_1" },
        { email: "ben@example.com", invitation_id: "inv_2" },
      ],
      skipped: [],
      failed: [],
    }

    render(<InviteMemberDialog open={true} onOpenChange={onOpenChange} />)

    expect(toast.success).toHaveBeenCalledWith("Sent 2 invites")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("uses friendly skipped reason copy in toast descriptions", () => {
    fetcherMock.data = {
      success: true,
      invited: [{ email: "ana@example.com", invitation_id: "inv_1" }],
      skipped: [
        { email: "ben@example.com", reason: "already_member" },
        { email: "cam@example.com", reason: "already_invited" },
        { email: "dan@example.com", reason: "duplicate" },
      ],
      failed: [],
    }

    render(<InviteMemberDialog open={true} onOpenChange={vi.fn()} />)

    expect(toast.success).toHaveBeenCalledWith("Sent 1 invite - 3 skipped", {
      description:
        "ben@example.com: already a member\ncam@example.com: invitation already sent\ndan@example.com: listed twice",
    })
  })
})
