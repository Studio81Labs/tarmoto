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

  it("styles every occurrence when a catalog repeats the placeholder", () => {
    const repeatedT: Translate = (key, values) => {
      if (key === "{percent} {surface}") {
        return `${String(values?.percent)} / ${String(values?.percent)}`;
      }
      return key;
    };

    const { container } = render(
      <span>
        <SurfaceLegendLabel
          formattedValue="71%"
          surface="Asphalt"
          t={repeatedT}
        />
      </span>,
    );

    expect(container.textContent).toBe("71% / 71%");
    expect(container.textContent).not.toContain("\uE000");
    expect(screen.getAllByText("71%")).toHaveLength(2);
    for (const percentage of screen.getAllByText("71%")) {
      expect(percentage).toHaveClass("font-bold", "text-ink");
    }
  });
});
