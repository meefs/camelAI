import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { ProfileForm } from "@/components/settings/profile-form";
import { WorkspaceGeneralForm } from "@/components/settings/workspace-general-form";
import type { Avatar, User, Workspace } from "@/types";

type FetcherState = {
  state: "idle" | "submitting" | "loading";
  data?: { success?: boolean; error?: string; avatar?: Avatar };
  submit: ReturnType<typeof vi.fn>;
};

type ActionDataState = {
  success?: boolean;
};

const {
  actionDataState,
  fetcherState,
  fetcherSubmitMock,
  revalidateMock,
  toastErrorMock,
  toastSuccessMock,
} = vi.hoisted(() => {
  const submit = vi.fn();
  return {
    fetcherSubmitMock: submit,
    fetcherState: {
      current: {
        state: "idle",
        data: undefined,
        submit,
      } as FetcherState,
    },
    actionDataState: { current: undefined as ActionDataState | undefined },
    revalidateMock: vi.fn(),
    toastErrorMock: vi.fn(),
    toastSuccessMock: vi.fn(),
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("react-router", async () => {
  const React = await import("react");
  return {
    Form: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      React.createElement("form", props, children),
    useActionData: () => actionDataState.current,
    useFetcher: () => fetcherState.current,
    useNavigation: () => ({ state: "idle" }),
    useRevalidator: () => ({ revalidate: revalidateMock }),
  };
});

const user: User = {
  id: "user_1",
  email: "user@example.com",
  email_verified_at: null,
  name: "User",
  created_at: 1,
  is_superuser: false,
  avatar: { color: "#4F46E5", content: "U" },
  is_orphaned: false,
  orphaned_at: null,
};

const workspace: Workspace = {
  id: "workspace_1",
  org_id: "org_1",
  name: "Workspace",
  description: "Workspace description",
  created_by: "user_1",
  created_at: 1,
  avatar: { color: "#4F46E5", content: "W" },
  archived: false,
  archived_at: null,
  archived_by: null,
  compute_tier: "standard",
  email_handle: "workspace",
};

function resetFetcher(data?: FetcherState["data"]) {
  fetcherState.current = {
    state: "idle",
    data,
    submit: fetcherSubmitMock,
  } as FetcherState;
}

function resetActionData(data?: ActionDataState) {
  actionDataState.current = data;
}

describe("settings avatar modal saves", () => {
  beforeEach(() => {
    fetcherSubmitMock.mockClear();
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    revalidateMock.mockClear();
    resetActionData();
    resetFetcher();
  });

  it("submits and previews a profile avatar when the modal Save is pressed", async () => {
    const { container, rerender } = render(<ProfileForm user={user} />);
    const formSubmit = vi.fn((event: Event) => event.preventDefault());
    container.querySelector("form")?.addEventListener("submit", formSubmit);

    fireEvent.click(screen.getByRole("button", { name: "Change avatar" }));
    fireEvent.click(screen.getByLabelText("Select color #8E7CC0"));
    fireEvent.change(screen.getByLabelText("Or enter custom initials"), {
      target: { value: "AB" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(fetcherSubmitMock).toHaveBeenCalledWith(
      {
        intent: "updateAvatar",
        avatarColor: "#8E7CC0",
        avatarContent: "AB",
      },
      { method: "post" },
    );
    expect(formSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("AB")).toBeInTheDocument();

    resetFetcher({
      success: true,
      avatar: { color: "#8E7CC0", content: "AB" },
    });
    rerender(<ProfileForm user={user} />);

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("Avatar updated");
    });
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(revalidateMock).toHaveBeenCalledTimes(1);

    rerender(<ProfileForm user={user} />);

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(revalidateMock).toHaveBeenCalledTimes(1);
  });

  it("handles persisted profile form success data once", async () => {
    resetActionData({ success: true });
    const { rerender } = render(<ProfileForm user={user} />);

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("Profile updated");
    });
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(revalidateMock).toHaveBeenCalledTimes(1);

    rerender(<ProfileForm user={user} />);

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(revalidateMock).toHaveBeenCalledTimes(1);
  });

  it("submits and previews a workspace avatar when the modal Save is pressed", async () => {
    const { container, rerender } = render(
      <WorkspaceGeneralForm
        workspace={workspace}
        workspaceEmailAddress="workspace@example.com"
        canEdit
      />,
    );
    const formSubmit = vi.fn((event: Event) => event.preventDefault());
    container.querySelector("form")?.addEventListener("submit", formSubmit);

    fireEvent.click(screen.getByRole("button", { name: "Change avatar" }));
    fireEvent.click(screen.getByLabelText("Select color #4F9B81"));
    fireEvent.change(screen.getByLabelText("Or enter custom initials"), {
      target: { value: "WX" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(fetcherSubmitMock).toHaveBeenCalledWith(
      {
        intent: "updateAvatar",
        avatarColor: "#4F9B81",
        avatarContent: "WX",
      },
      { method: "post" },
    );
    expect(formSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("WX")).toBeInTheDocument();

    resetFetcher({
      success: true,
      avatar: { color: "#4F9B81", content: "WX" },
    });
    rerender(
      <WorkspaceGeneralForm
        workspace={workspace}
        workspaceEmailAddress="workspace@example.com"
        canEdit
      />,
    );

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("Avatar updated");
    });
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(revalidateMock).toHaveBeenCalledTimes(1);

    rerender(
      <WorkspaceGeneralForm
        workspace={workspace}
        workspaceEmailAddress="workspace@example.com"
        canEdit
      />,
    );

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(revalidateMock).toHaveBeenCalledTimes(1);
  });

  it("handles persisted workspace form success data once", async () => {
    resetActionData({ success: true });
    const { rerender } = render(
      <WorkspaceGeneralForm
        workspace={workspace}
        workspaceEmailAddress="workspace@example.com"
        canEdit
      />,
    );

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("Workspace updated");
    });
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(revalidateMock).toHaveBeenCalledTimes(1);

    rerender(
      <WorkspaceGeneralForm
        workspace={workspace}
        workspaceEmailAddress="workspace@example.com"
        canEdit
      />,
    );

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(revalidateMock).toHaveBeenCalledTimes(1);
  });
});
