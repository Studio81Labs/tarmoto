import { render, screen } from "@testing-library/react";
import type { Translate } from "@/i18n";
import { HazardSeverityLabel } from "./SegmentDetailSidebar";

describe("HazardSeverityLabel", () => {
  it("preserves catalog ordering while visually distinguishing severity", () => {
    const reorderedT: Translate = (key, values) => {
      if (key === "{hazard} {severity}") {
        return `${String(values?.severity)} — ${String(values?.hazard)}`;
      }
      return key;
    };

    const { container } = render(
      <p>
        <HazardSeverityLabel hazard="Pothole" severity="High" t={reorderedT} />
      </p>,
    );

    expect(container.textContent).toBe("High — Pothole");
    expect(screen.getByText("High")).toHaveClass(
      "text-[10px]",
      "uppercase",
      "tracking-wider",
      "text-fg-dim",
    );
  });
});
