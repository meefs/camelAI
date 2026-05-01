import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const fetcherMock = vi.hoisted(() => ({
  state: "idle",
  data: undefined as unknown,
}))

vi.mock("react-router", () => ({
  useFetcher: () => ({
    state: fetcherMock.state,
    data: fetcherMock.data,
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

  it("shows the live Team seat billing notice when invites add seats", async () => {
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

    expect(screen.getByText("Adding 1 seat to your Team plan")).toBeInTheDocument()
    expect(
      screen.getByText(
        "Your Team subscription will go from 3 to 4 seats. We'll bill a prorated amount for the rest of your current billing period today, and your future monthly invoices will increase by $50.00.",
      ),
    ).toBeInTheDocument()
  })

  it("hides the Team seat billing notice by default", () => {
    render(<InviteMemberDialog open={true} onOpenChange={vi.fn()} />)

    expect(
      screen.queryByText("Adding 1 seat to your Team plan"),
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

    expect(screen.getByText("No billing change")).toBeInTheDocument()
    expect(screen.queryByText("Billing update is paused")).not.toBeInTheDocument()
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

    expect(screen.getByText("Billing update is paused")).toBeInTheDocument()
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

  it("updates disclosed billing fields when submit commits pending text", async () => {
    const user = userEvent.setup()
    const { container } = render(
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

    const input = document.querySelector<HTMLInputElement>("#invite-emails")!
    await user.type(input, "ana@example.com{enter}ben@example.com{enter}cam@example.com")

    expect(
      document.querySelector<HTMLInputElement>('input[name="disclosed_added_seat_count"]')?.value,
    ).toBe("2")

    fireEvent.submit(document.querySelector("form")!)

    expect(
      document.querySelector<HTMLInputElement>('input[name="disclosed_added_seat_count"]')?.value,
    ).toBe("3")
    expect(
      document.querySelector<HTMLInputElement>('input[name="disclosed_next_seat_count"]')?.value,
    ).toBe("6")
    expect(document.querySelectorAll('input[name="emails"]')).toHaveLength(3)
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
        { email: "ben@example.com", reason: "RESEND_API_KEY is not configured" },
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
