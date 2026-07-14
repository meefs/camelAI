import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntegrationIcon } from "@/lib/integration-icons";

describe("IntegrationIcon", () => {
  it("uses CSS theme selection for themed logos", () => {
    render(<IntegrationIcon type="grok" size={16} className="opacity-80" />);

    const icon = screen.getByRole("img", { name: "grok" });
    expect(icon.tagName).toBe("SPAN");
    expect(icon).not.toHaveAttribute("src");
    expect(icon).toHaveClass(
      "[background-image:var(--integration-icon-light)]",
    );
    expect(icon.className).toContain(
      "dark:[background-image:var(--integration-icon-dark)]",
    );
    expect(icon.style.getPropertyValue("--integration-icon-light")).toBe(
      "url(/logos/grok_light.svg)",
    );
    expect(icon.style.getPropertyValue("--integration-icon-dark")).toBe(
      "url(/logos/grok_dark.svg)",
    );
  });

  it("keeps single-variant logos as images", () => {
    render(<IntegrationIcon type="claude" size={16} />);

    const icon = screen.getByRole("img", { name: "claude" });
    expect(icon.tagName).toBe("IMG");
    expect(icon).toHaveAttribute("src", "/logos/claude.svg");
  });

  it("uses the camelAI favicon directly", () => {
    render(<IntegrationIcon type="camelai" size={16} />);

    expect(screen.getByRole("img", { name: "camelai" })).toHaveAttribute(
      "src",
      "/favicon.svg",
    );
  });

  it("uses the Telegram logo as a single-variant image", () => {
    render(<IntegrationIcon type="telegram" size={16} />);

    const icon = screen.getByRole("img", { name: "telegram" });
    expect(icon.tagName).toBe("IMG");
    expect(icon).toHaveAttribute("src", "/logos/telegram.svg");
  });
});
