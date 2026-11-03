import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SiteHeader } from "@/components/landing/SiteHeader";

describe("SiteHeader", () => {
  afterEach(cleanup);

  it("opens the menu from the button and closes it on Escape", () => {
    render(<SiteHeader />);
    const menu = screen.getByRole("button", { name: /menu/i });
    expect(menu.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("navigation").dataset.open).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(menu);
  });

  it("closes the menu when a link is picked", () => {
    render(<SiteHeader />);
    fireEvent.click(screen.getByRole("button", { name: /menu/i }));
    fireEvent.click(screen.getByRole("link", { name: "Bots" }));
    expect(screen.getByRole("navigation").dataset.open).toBe("false");
  });
});
