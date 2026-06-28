import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { QUALITY_COLORS } from "@/theme/brand";
import { BrandButton, Chip, Metric, QualityBars, Stamp } from "../index";

describe("Stamp", () => {
  it("renders its label", () => {
    render(<Stamp>Roads near you</Stamp>);
    expect(screen.getByText("Roads near you")).toBeTruthy();
  });
});

describe("Chip", () => {
  it("renders the label and fires onPress", () => {
    const onPress = jest.fn();
    render(
      <Chip active onPress={onPress}>
        Excellent
      </Chip>,
    );
    const chip = screen.getByText("Excellent");
    fireEvent.press(chip);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("exposes its selected state to assistive tech", () => {
    render(<Chip active>Hazards</Chip>);
    const chip = screen.getByRole("button");
    expect(chip.props.accessibilityState).toMatchObject({ selected: true });
  });
});

describe("Metric", () => {
  it("renders value, unit and label", () => {
    render(<Metric value="186" unit="km" label="This week" />);
    expect(screen.getByText("186")).toBeTruthy();
    expect(screen.getByText("km")).toBeTruthy();
    expect(screen.getByText("This week")).toBeTruthy();
  });
});

describe("BrandButton", () => {
  it("renders its label and fires onPress", () => {
    const onPress = jest.fn();
    render(
      <BrandButton accent onPress={onPress}>
        Start commute
      </BrandButton>,
    );
    fireEvent.press(screen.getByText("Start commute"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("does not fire onPress when disabled", () => {
    const onPress = jest.fn();
    render(
      <BrandButton onPress={onPress} disabled>
        Generate loop
      </BrandButton>,
    );
    fireEvent.press(screen.getByText("Generate loop"));
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe("QualityBars", () => {
  // Walk the rendered tree and collect every leaf bar's background colour.
  // The meter is five sibling Views; filled bars take the score's ramp
  // colour, the rest take the empty tone.
  function barColors(
    tree: ReturnType<typeof render>["toJSON"] extends never
      ? never
      : ReturnType<ReturnType<typeof render>["toJSON"]>,
  ): string[] {
    const out: string[] = [];
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as { children?: unknown[]; props?: { style?: unknown } };
      const children = n.children;
      const isLeaf = !children || children.length === 0;
      if (isLeaf && n.props?.style) {
        const style = Array.isArray(n.props.style)
          ? Object.assign({}, ...n.props.style)
          : (n.props.style as { backgroundColor?: string });
        if (style.backgroundColor) out.push(style.backgroundColor);
      }
      children?.forEach(visit);
    };
    visit(tree);
    return out;
  }

  it("fills exactly q bars with the score's ramp colour", () => {
    const { toJSON } = render(<QualityBars q={3} empty="#000000" />);
    const colors = barColors(toJSON());
    const filled = colors.filter((c) => c === QUALITY_COLORS[2]);
    const empty = colors.filter((c) => c === "#000000");
    expect(filled).toHaveLength(3);
    expect(empty).toHaveLength(2);
  });
});
