import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RouteOutlineSvg } from "./RouteOutlineSvg";

describe("RouteOutlineSvg", () => {
  it("renders one base + one overlay path per day, plus start/end pins", () => {
    const { container } = render(
      <RouteOutlineSvg
        geometry={[
          [
            [14.4, 50.0],
            [14.5, 50.1],
            [14.6, 50.05],
          ],
          [
            [14.6, 50.05],
            [14.8, 50.2],
          ],
        ]}
      />,
    );
    // 2 days × (base + overlay).
    expect(container.querySelectorAll("path")).toHaveLength(4);
    // Start + end pins.
    expect(container.querySelectorAll("circle")).toHaveLength(2);
  });

  it("fits every point inside the viewBox", () => {
    const { container } = render(
      <RouteOutlineSvg
        geometry={[
          [
            [8, 45],
            [12, 47],
            [10, 46.5],
          ],
        ]}
      />,
    );
    const nums = (container.querySelector("path")!.getAttribute("d") ?? "")
      .match(/-?\d+(?:\.\d+)?/g)!
      .map(Number);
    for (let i = 0; i < nums.length; i += 2) {
      expect(nums[i]).toBeGreaterThanOrEqual(0);
      expect(nums[i]!).toBeLessThanOrEqual(180);
      expect(nums[i + 1]).toBeGreaterThanOrEqual(0);
      expect(nums[i + 1]!).toBeLessThanOrEqual(100);
    }
  });

  it("renders nothing when no line has two points", () => {
    const { container } = render(<RouteOutlineSvg geometry={[[[1, 2]]]} />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
