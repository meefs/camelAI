import { describe, expect, it, vi } from "vitest";
import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

  it("still handles number keys and Enter when focus has moved to a non-editable control", async () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <>
        <button type="button">Outside button</button>
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

    const outsideButton = screen.getByRole("button", { name: "Outside button" });
    outsideButton.focus();
    expect(outsideButton).toHaveFocus();

    fireEvent.keyDown(outsideButton, { key: "2" });
    fireEvent.keyDown(outsideButton, { key: "Enter" });

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        "Which framework do you want?": "Remix",
      });
    });
  });

  it("ignores shortcuts while focus is in an outside textarea", async () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <>
        <textarea aria-label="Outside textarea" />
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

    const outsideTextarea = screen.getByLabelText("Outside textarea");
    outsideTextarea.focus();
    expect(outsideTextarea).toHaveFocus();

    const submitButton = screen.getByRole("button", { name: "Submit" });
    expect(submitButton).toBeDisabled();

    const digitEvent = createEvent.keyDown(outsideTextarea, { key: "2" });
    fireEvent(outsideTextarea, digitEvent);
    expect(digitEvent.defaultPrevented).toBe(false);

    const enterEvent = createEvent.keyDown(outsideTextarea, { key: "Enter" });
    fireEvent(outsideTextarea, enterEvent);
    expect(enterEvent.defaultPrevented).toBe(false);

    expect(submitButton).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("ignores shortcuts while focus is in an outside contenteditable region", async () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <>
        <div
          contentEditable
          suppressContentEditableWarning
          tabIndex={0}
          data-testid="outside-editor"
        >
          Draft message
        </div>
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
        />
      </>,
    );

    const widget = getWidget(container);
    await waitFor(() => {
      expect(widget).toHaveFocus();
    });

    const outsideEditor = screen.getByTestId("outside-editor");
    outsideEditor.focus();
    expect(outsideEditor).toHaveFocus();

    const zeroEvent = createEvent.keyDown(outsideEditor, { key: "0" });
    fireEvent(outsideEditor, zeroEvent);
    expect(zeroEvent.defaultPrevented).toBe(false);

    const enterEvent = createEvent.keyDown(outsideEditor, { key: "Enter" });
    fireEvent(outsideEditor, enterEvent);
    expect(enterEvent.defaultPrevented).toBe(false);

    expect(screen.queryByPlaceholderText("Type your answer...")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
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

    await new Promise((resolve) => window.setTimeout(resolve, 150));
    expect(otherInput).toHaveFocus();

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
        screen.getByRole("button", { name: /agent needs your input/i }),
      ).toHaveFocus();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
