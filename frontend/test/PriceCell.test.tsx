import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PriceCell } from "@/components/ui/PriceCell";

describe("PriceCell", () => {
  it("doesn't flash on first render", () => {
    render(<PriceCell cents={14237} />);
    expect(screen.getByText("142.37").dataset.direction).toBe("flat");
  });

  it("flashes the direction the price moved", () => {
    const { rerender } = render(<PriceCell cents={14237} />);
    rerender(<PriceCell cents={14238} />);
    expect(screen.getByText("142.38").dataset.direction).toBe("up");
    rerender(<PriceCell cents={14230} />);
    expect(screen.getByText("142.30").dataset.direction).toBe("down");
  });
});
