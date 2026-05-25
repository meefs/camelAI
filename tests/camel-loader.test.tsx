import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("CamelLoader", () => {
  let originalSvgPathElement: PropertyDescriptor | undefined;
  let originalRequestAnimationFrame: PropertyDescriptor | undefined;
  let originalCancelAnimationFrame: PropertyDescriptor | undefined;
  let originalGetTotalLength: PropertyDescriptor | undefined;
  let originalGetPointAtLength: PropertyDescriptor | undefined;
  let nextFrame: FrameRequestCallback | null;

  beforeEach(() => {
    vi.resetModules();
    originalSvgPathElement = Object.getOwnPropertyDescriptor(
      window,
      "SVGPathElement",
    );
    originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(
      window,
      "requestAnimationFrame",
    );
    originalCancelAnimationFrame = Object.getOwnPropertyDescriptor(
      window,
      "cancelAnimationFrame",
    );
    originalGetTotalLength = Object.getOwnPropertyDescriptor(
      SVGElement.prototype,
      "getTotalLength",
    );
    originalGetPointAtLength = Object.getOwnPropertyDescriptor(
      SVGElement.prototype,
      "getPointAtLength",
    );
    nextFrame = null;

    Object.defineProperty(window, "SVGPathElement", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        nextFrame = callback;
        return 1;
      }),
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    Object.defineProperty(SVGElement.prototype, "getTotalLength", {
      configurable: true,
      writable: true,
      value: vi.fn(() => 1000),
    });
    Object.defineProperty(SVGElement.prototype, "getPointAtLength", {
      configurable: true,
      writable: true,
      value: vi.fn((distance: number) => ({
        x: distance,
        y: distance / 2,
      })),
    });
  });

  afterEach(() => {
    restoreWindowProperty("SVGPathElement", originalSvgPathElement);
    restoreWindowProperty(
      "requestAnimationFrame",
      originalRequestAnimationFrame,
    );
    restoreWindowProperty(
      "cancelAnimationFrame",
      originalCancelAnimationFrame,
    );
    restorePrototypeProperty(
      SVGElement.prototype,
      "getTotalLength",
      originalGetTotalLength,
    );
    restorePrototypeProperty(
      SVGElement.prototype,
      "getPointAtLength",
      originalGetPointAtLength,
    );
    vi.restoreAllMocks();
  });

  it("starts morphing without the SVGPathElement constructor", async () => {
    const { CamelLoader } = await import(
      "@/components/camel-loader/camel-loader"
    );

    render(<CamelLoader ariaLabel="Agent is working" />);

    const svg = screen.getByLabelText("Agent is working");
    const path = svg.querySelector("path");
    const initialPath = path?.getAttribute("d");

    await waitFor(() => {
      expect(window.requestAnimationFrame).toHaveBeenCalled();
    });

    act(() => {
      nextFrame?.(performance.now() + 250);
    });

    await waitFor(() => {
      expect(path?.getAttribute("d")).not.toBe(initialPath);
    });
  });

  it("does not crash the animation loop for invalid durations", async () => {
    const { CamelLoader } = await import(
      "@/components/camel-loader/camel-loader"
    );

    render(<CamelLoader ariaLabel="Agent is working" duration={0} />);

    const svg = screen.getByLabelText("Agent is working");
    const path = svg.querySelector("path");
    const initialPath = path?.getAttribute("d");

    await waitFor(() => {
      expect(window.requestAnimationFrame).toHaveBeenCalled();
    });

    expect(() => {
      act(() => {
        nextFrame?.(performance.now() + 250);
      });
    }).not.toThrow();

    await waitFor(() => {
      expect(path?.getAttribute("d")).not.toBe(initialPath);
    });
  });
});

function restoreWindowProperty(
  property: string,
  descriptor: PropertyDescriptor | undefined,
) {
  restorePrototypeProperty(window, property, descriptor);
}

function restorePrototypeProperty(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
  } else {
    Reflect.deleteProperty(target, property);
  }
}
