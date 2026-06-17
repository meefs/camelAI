import { describe, expect, it, vi } from "vitest";
import {
  confirmDestructiveAction,
  isDestructiveActionConfirmed,
} from "../src/confirmed-destructive-action";
import {
  collectProjectDeletionTargets,
  orderProjectsForRuntimeDelete,
} from "../src/project-deletion";

describe("confirmed-destructive-action", () => {
  it("treats the confirm label as acceptance", () => {
    expect(isDestructiveActionConfirmed(
      { "Delete project web-app?": "Delete" },
      "Delete project web-app?",
    )).toBe(true);
    expect(isDestructiveActionConfirmed(
      { "Delete project web-app?": "Cancel" },
      "Delete project web-app?",
    )).toBe(false);
  });

  it("returns unavailable when AskUserQuestion cannot reach the user", async () => {
    const askUserQuestion = vi.fn(async () => ({
      unavailable_reason: "User is not at computer",
    }));
    await expect(confirmDestructiveAction(askUserQuestion, {
      question: "Delete connection stripe?",
    })).resolves.toEqual({
      confirmed: false,
      unavailableReason: "User is not at computer",
    });
  });

  it("confirms destructive actions through AskUserQuestion", async () => {
    const askUserQuestion = vi.fn(async () => ({
      "Delete connection stripe?": "Delete",
    }));
    await expect(confirmDestructiveAction(askUserQuestion, {
      question: "Delete connection stripe?",
    })).resolves.toEqual({ confirmed: true });
    expect(askUserQuestion).toHaveBeenCalledWith({
      questions: [{
        question: "Delete connection stripe?",
        header: "Confirm deletion",
        multiSelect: false,
        options: [
          { label: "Delete", description: "Proceed with this destructive action." },
          { label: "Cancel", description: "Keep the existing resource unchanged." },
        ],
      }],
    });
  });
});

describe("project-deletion", () => {
  it("orders clone projects before their sources", () => {
    expect(orderProjectsForRuntimeDelete([
      { id: "source", clonedFromProjectId: undefined },
      { id: "clone-a", clonedFromProjectId: "source" },
      { id: "clone-b", clonedFromProjectId: "clone-a" },
    ])).toEqual(["clone-b", "clone-a", "source"]);
  });

  it("includes clone descendants when deleting a source project", () => {
    const source = {
      id: "source",
      name: "web-app",
      description: "Main app",
      defaultVmId: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const clone = {
      id: "clone",
      name: "web-app-experiment",
      description: "Clone",
      defaultVmId: "main",
      clonedFromProjectId: "source",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    expect(collectProjectDeletionTargets([source, clone], source).map((project) => project.id))
      .toEqual(["source", "clone"]);
    expect(collectProjectDeletionTargets([source, clone], clone).map((project) => project.id))
      .toEqual(["clone"]);
  });
});
