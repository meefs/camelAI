import { describe, expect, it } from "vitest";

import { boundedInteger } from "../workers/main/src/mcp-bounded-integer";
import {
  objectArg,
  parseJsonObject,
  requireString,
  textToolResult,
} from "../workers/main/src/mcp-values";

describe("MCP value helpers", () => {
  it("formats tool results and accepts only record-shaped arguments", () => {
    expect(textToolResult("already text")).toEqual({
      content: [{ type: "text", text: "already text" }],
    });
    expect(textToolResult({ value: 1 })).toEqual({
      content: [{ type: "text", text: '{\n  "value": 1\n}' }],
    });
    expect(objectArg({ nested: true })).toEqual({ nested: true });
    expect(objectArg([])).toEqual({});
    expect(objectArg(null)).toEqual({});
  });

  it("parses JSON records and rejects every other JSON shape", () => {
    expect(parseJsonObject('{"enabled":true}')).toEqual({ enabled: true });
    expect(parseJsonObject("[1, 2]")).toEqual({});
    expect(parseJsonObject("null")).toEqual({});
    expect(parseJsonObject("not json")).toEqual({});
    expect(parseJsonObject(null)).toEqual({});
  });

  it("requires a trimmed string with the provider-compatible error envelope", () => {
    expect(requireString("  workspace-id  ", "workspaceId")).toBe("workspace-id");
    for (const value of [undefined, null, 0, false, {}, [], "", "   "]) {
      expect(() => requireString(value, "workspaceId")).toThrow(
        "workspaceId is required",
      );
    }
    try {
      requireString("\t\n", "projectId");
      throw new Error("Expected requireString to reject whitespace");
    } catch (error) {
      expect(error).toMatchObject({ message: "projectId is required", status: 400 });
    }
  });

  it("supports defaulted and required bounded integers without flooring", () => {
    expect(boundedInteger(undefined, 25, 1, 100, "limit")).toBe(25);
    expect(boundedInteger("12", 25, 1, 100, "limit")).toBe(12);
    expect(boundedInteger(1, 1, 100, "limit")).toBe(1);
    expect(boundedInteger(100, 1, 100, "limit")).toBe(100);
    expect(() => boundedInteger("2.9", 1, 100, "limit")).toThrow(
      "limit must be an integer from 1 to 100.",
    );
    try {
      boundedInteger(undefined, 1, 100, "limit");
      throw new Error("Expected boundedInteger to reject an omitted value");
    } catch (error) {
      expect(error).toMatchObject({
        message: "limit must be an integer from 1 to 100.",
        status: 400,
      });
    }
  });
});
