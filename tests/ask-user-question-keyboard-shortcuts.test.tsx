import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AskUserQuestion,
  type AskUserQuestionData,
} from "@/components/ask-user-question";

function getWidget(container: HTMLElement): HTMLDivElement {
  const widget = container.querySelector<HTMLDivElement>(
    '[data-ask-user-question-root="true"]',
  );
  if (!widget) {
    throw new Error("AskUserQuestion root was not rendered");
  }

  return widget;
}

function makeData(
  questions: AskUserQuestionData["questions"],
): AskUserQuestionData {
  return {
    questionId: "question-1",
    toolUseId: "tool-1",
    questions,
  };
}

describe("AskUserQuestion keyboard shortcuts", () => {
  it("renders nothing when there are no questions", () => {
    const { container } = render(
      <AskUserQuestion data={makeData([])} onSubmit={vi.fn()} />,
    );

    expect(
      container.querySelector('[data-ask-user-question-root="true"]'),
    ).toBeNull();
  });

  it("submits a single-select answer with a number key and Enter", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <AskUserQuestion
        data={makeData([
          {
            header: "Framework",
            question: "Which framework do you want?",
            multiSelect: false,
            options: [
              { label: "Next.js", description: "" },
              { label: "Remix", description: "" },
              { label: "Astro", description: "" },
            ],
          },
        ])}
        onSubmit={onSubmit}
      />,
    );

    const widget = getWidget(container);
    await waitFor(() => {
      expect(widget).toHaveFocus();
    });

    await user.keyboard("2{Enter}");

    expect(onSubmit).toHaveBeenCalledWith({
      "Which framework do you want?": "Remix",
    });
  });

  it("still handles number keys and Enter when focus has moved outside the widget", async () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <>
        <input aria-label="Outside input" />
        <AskUserQuestion
          data={makeData([
            {
              header: "Framework",
              question: "Which framework do you want?",
              multiSelect: false,
              options: [
                { label: "Next.js", description: "" },
                { label: "Remix", description: "" },
                { label: "Astro", description: "" },
              ],
            },
          ])}
          onSubmit={onSubmit}
        />
      </>,
    );

    const widget = getWidget(container);
    await waitFor(() => {
      expect(widget).toHaveFocus();
    });

    const outsideInput = screen.getByLabelText("Outside input");
    outsideInput.focus();
    expect(outsideInput).toHaveFocus();

    fireEvent.keyDown(window, { key: "2" });
    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        "Which framework do you want?": "Remix",
      });
    });
  });

  it("advances multi-question flows with Enter and submits the full answer set", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <AskUserQuestion
        data={makeData([
          {
            header: "Framework",
            question: "Which framework do you want?",
            multiSelect: false,
            options: [
              { label: "Next.js", description: "" },
              { label: "Remix", description: "" },
            ],
          },
          {
            header: "Database",
            question: "Which database do you want?",
            multiSelect: false,
            options: [
              { label: "PostgreSQL", description: "" },
              { label: "SQLite", description: "" },
            ],
          },
        ])}
        onSubmit={onSubmit}
      />,
    );

    const widget = getWidget(container);
    await waitFor(() => {
      expect(widget).toHaveFocus();
    });

    await user.keyboard("2{Enter}");

    expect(screen.getByText("Which database do you want?")).toBeInTheDocument();
    expect(screen.getByText("# to pick · ↵ submit")).toBeInTheDocument();

    await waitFor(() => {
      expect(widget).toHaveFocus();
    });

    await user.keyboard("1{Enter}");

    expect(onSubmit).toHaveBeenCalledWith({
      "Which framework do you want?": "Remix",
      "Which database do you want?": "PostgreSQL",
    });
  });

  it("uses arrow keys and Space to toggle multi-select options before submitting", async () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AskUserQuestion
        data={makeData([
          {
            header: "Tooling",
            question: "Which tools should I set up?",
            multiSelect: true,
            options: [
              { label: "ESLint", description: "" },
              { label: "Prettier", description: "" },
              { label: "TypeScript", description: "" },
            ],
          },
        ])}
        onSubmit={onSubmit}
      />,
    );

    const widget = getWidget(container);
    await waitFor(() => {
      expect(widget).toHaveFocus();
    });

    fireEvent.keyDown(widget, { key: "ArrowDown" });
    fireEvent.keyDown(widget, { key: " ", code: "Space" });
    fireEvent.keyDown(widget, { key: "ArrowDown" });
    fireEvent.keyDown(widget, { key: " ", code: "Space" });
    fireEvent.keyDown(widget, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith({
      "Which tools should I set up?": "Prettier, TypeScript",
    });
  });

  it("selects Other with 0, focuses its input, and submits the typed answer", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <AskUserQuestion
        data={makeData([
          {
            header: "Framework",
            question: "Which framework do you want?",
            multiSelect: false,
            options: [
              { label: "Next.js", description: "" },
              { label: "Remix", description: "" },
            ],
          },
        ])}
        onSubmit={onSubmit}
      />,
    );

    const widget = getWidget(container);
    await waitFor(() => {
      expect(widget).toHaveFocus();
    });

    await user.keyboard("0");

    const otherInput = await screen.findByPlaceholderText(
      "Type your answer...",
    );
    await waitFor(() => {
      expect(otherInput).toHaveFocus();
    });

    await user.type(otherInput, "SvelteKit");
    await user.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledWith({
      "Which framework do you want?": "SvelteKit",
    });
  });

  it("keeps focus in the Other input when Space selects the focused Other row", async () => {
    const { container } = render(
      <AskUserQuestion
        data={makeData([
          {
            header: "Framework",
            question: "Which framework do you want?",
            multiSelect: false,
            options: [
              { label: "Next.js", description: "" },
              { label: "Remix", description: "" },
            ],
          },
        ])}
        onSubmit={vi.fn()}
      />,
    );

    const widget = getWidget(container);
    await waitFor(() => {
      expect(widget).toHaveFocus();
    });

    fireEvent.keyDown(widget, { key: "ArrowDown" });
    fireEvent.keyDown(widget, { key: "ArrowDown" });
    fireEvent.keyDown(widget, { key: " ", code: "Space" });

    const otherInput = await screen.findByPlaceholderText(
      "Type your answer...",
    );
    await waitFor(() => {
      expect(otherInput).toHaveFocus();
    });
  });

  it("uses Escape to blur the Other input back to the widget and then collapse the widget", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <AskUserQuestion
        data={makeData([
          {
            header: "Framework",
            question: "Which framework do you want?",
            multiSelect: false,
            options: [
              { label: "Next.js", description: "" },
              { label: "Remix", description: "" },
            ],
          },
        ])}
        onSubmit={onSubmit}
      />,
    );

    const widget = getWidget(container);
    await waitFor(() => {
      expect(widget).toHaveFocus();
    });

    await user.keyboard("0");

    const otherInput = await screen.findByPlaceholderText(
      "Type your answer...",
    );
    await waitFor(() => {
      expect(otherInput).toHaveFocus();
    });

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(widget).toHaveFocus();
    });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /claude needs your input/i }),
      ).toHaveFocus();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
