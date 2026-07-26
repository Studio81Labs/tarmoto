import { render, screen } from "@testing-library/react";
import type { Translate } from "@/i18n";
import { SurfaceLegendLabel } from "./SurfaceMixBar";

describe("SurfaceLegendLabel", () => {
  it("preserves catalog ordering while emphasizing the percentage", () => {
    const reorderedT: Translate = (key, values) => {
      if (key === "{percent} {surface}") {
        return `${String(values?.surface)}: ${String(values?.percent)}`;
      }
      return key;
    };

    const { container } = render(
      <span>
        <SurfaceLegendLabel
          formattedValue="71%"
          surface="Asphalt"
          t={reorderedT}
        />
      </span>,
    );

    expect(container.textContent).toBe("Asphalt: 71%");
    expect(screen.getByText("71%")).toHaveClass("font-bold", "text-ink");
  });
});
