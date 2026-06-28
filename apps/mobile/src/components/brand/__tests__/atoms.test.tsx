import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";

// Stub react-native-svg primitives — the jest preset doesn't register the
// native host views, and these tests only assert props, not pixels.
jest.mock("react-native-svg", () => {
  const ReactLib = require("react");
  const stub = (name: string) => {
    const C = (props: Record<string, unknown>) =>
      ReactLib.createElement(name, props, props.children as React.ReactNode);
    C.displayName = name;
    return C;
  };
  return {
    __esModule: true,
    default: stub("Svg"),
    Svg: stub("Svg"),
    Path: stub("Path"),
    Circle: stub("Circle"),
    Rect: stub("Rect"),
  };
});

import {
  brandColorsDark,
  brandColorsLight,
  QUALITY_COLORS,
} from "@/theme/brand";
import {
  BrandButton,
  BrandIcon,
  Card,
  Chip,
  Metric,
  QualityBars,
  Stamp,
  Toggle,
} from "../index";
import { Text } from "react-native";

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

  it("expands the touch target to the glove-first 44px minimum", () => {
    // Compact pill (~32px) + 7px top/bottom hitSlop clears the 44px target.
    render(<Chip>Gravel</Chip>);
    const chip = screen.getByRole("button");
    expect(chip.props.hitSlop).toMatchObject({ top: 7, bottom: 7 });
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

  it("rounds a fractional score so colour and fill count agree", () => {
    // 3.6 rounds to bucket Q4: four bars filled, all in the Q4 colour.
    const { toJSON } = render(<QualityBars q={3.6} empty="#000000" />);
    const colors = barColors(toJSON());
    expect(colors.filter((c) => c === QUALITY_COLORS[3])).toHaveLength(4);
    expect(colors.filter((c) => c === "#000000")).toHaveLength(1);
  });

  it("defaults empty bars to the dark palette tone on dark surfaces", () => {
    const { toJSON } = render(<QualityBars q={2} onDark />);
    const colors = barColors(toJSON());
    expect(colors).toContain(brandColorsDark.qEmpty);
    expect(colors).not.toContain(brandColorsLight.qEmpty);
  });

  it("exposes the score to screen readers, with an override", () => {
    const { rerender } = render(<QualityBars q={4} />);
    expect(screen.getByLabelText("Quality 4 of 5")).toBeTruthy();
    rerender(<QualityBars q={4} accessibilityLabel="Stelvio surface: great" />);
    expect(screen.getByLabelText("Stelvio surface: great")).toBeTruthy();
  });

  it("renders an unscored placeholder for null/undefined, not Q1", () => {
    // Unmeasured road: no filled bars, announced as unscored.
    const { toJSON } = render(<QualityBars q={null} empty="#000000" />);
    const colors = barColors(toJSON());
    expect(colors.every((c) => c === "#000000")).toBe(true);
    expect(colors.filter((c) => c === QUALITY_COLORS[0])).toHaveLength(0);
    expect(screen.getByLabelText("Quality unscored")).toBeTruthy();
  });
});

describe("Card", () => {
  it("renders its children", () => {
    render(
      <Card>
        <Text>Safety</Text>
      </Card>,
    );
    expect(screen.getByText("Safety")).toBeTruthy();
  });
});

describe("Toggle", () => {
  it("exposes switch role and checked state, and fires onToggle", () => {
    const onToggle = jest.fn();
    render(
      <Toggle
        on={false}
        onToggle={onToggle}
        accessibilityLabel="Crash detection"
      />,
    );
    const sw = screen.getByRole("switch");
    expect(sw.props.accessibilityState).toMatchObject({ checked: false });
    fireEvent.press(sw);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("does not fire when disabled", () => {
    const onToggle = jest.fn();
    render(<Toggle on onToggle={onToggle} disabled accessibilityLabel="x" />);
    fireEvent.press(screen.getByRole("switch"));
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("icon colour injection", () => {
  // A bare icon with no explicit colour should inherit the control's
  // resolved label colour (react-native-svg doesn't cascade currentColor).
  it("BrandButton injects its label colour into a bare icon", () => {
    // Default ink button -> cream label/icon colour, not black.
    const { UNSAFE_root } = render(
      <BrandButton icon={<BrandIcon name="nav" />}>Start</BrandButton>,
    );
    const icon = UNSAFE_root.findByType(BrandIcon);
    expect(icon.props.color).toBe("#F5EFE6");
  });

  it("does not override an explicit icon colour", () => {
    const { UNSAFE_root } = render(
      <BrandButton accent icon={<BrandIcon name="nav" color="#123456" />}>
        Go
      </BrandButton>,
    );
    const icon = UNSAFE_root.findByType(BrandIcon);
    expect(icon.props.color).toBe("#123456");
  });
});
