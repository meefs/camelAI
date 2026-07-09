import { describe, expect, it } from "vitest";

import { extractStartPrompt } from "../workers/eval-reports/src/ingest";

describe("extractStartPrompt", () => {
	it("prefers a top-level prompt string", () => {
		expect(
			extractStartPrompt({
				prompt: "  Build the dashboard  ",
				messages: [{ role: "user", content: "Ignore me" }],
			}),
		).toBe("Build the dashboard");
	});

	it("extracts the first user message with string content", () => {
		expect(
			extractStartPrompt({
				messages: [
					{ role: "system", content: "Setup" },
					{ role: "user", content: "\nCreate a project\n" },
					{ role: "user", content: "Second prompt" },
				],
			}),
		).toBe("Create a project");
	});

	it("skips empty user messages before the first real prompt", () => {
		expect(
			extractStartPrompt({
				messages: [
					{ role: "user", content: "   " },
					{ role: "user", content: "\nCreate the app\n" },
				],
			}),
		).toBe("Create the app");
	});

	it("joins text blocks in array content and ignores non-text blocks", () => {
		expect(
			extractStartPrompt({
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "First" },
							{ type: "image", text: "ignored" },
							{ type: "text", text: "Second" },
						],
					},
				],
			}),
		).toBe("First\n\nSecond");
	});

	it("returns undefined when no non-empty prompt exists", () => {
		expect(extractStartPrompt({ messages: [{ role: "assistant", content: "hi" }] })).toBeUndefined();
		expect(extractStartPrompt({ prompt: "   " })).toBeUndefined();
		expect(extractStartPrompt(null)).toBeUndefined();
	});

	it("truncates prompts longer than 4000 characters", () => {
		const result = extractStartPrompt({ prompt: "a".repeat(4001) });
		expect(result).toHaveLength(4001);
		expect(result?.endsWith("…")).toBe(true);
	});
});
