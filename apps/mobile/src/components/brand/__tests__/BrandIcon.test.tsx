import React from "react";
import { render } from "@testing-library/react-native";

// react-native-svg renders native host views that the jest preset does not
// register. Stub the primitives so the glyph tree renders as plain mock
// elements — we only assert that BrandIcon resolves a name to some SVG
// content without throwing, not pixel output.
jest.mock("react-native-svg", () => {
  const React = require("react");
  const stub = (name: string) => {
    const C = (props: Record<string, unknown>) =>
      React.createElement(name, props, props.children as React.ReactNode);
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

import BrandIcon from "../BrandIcon";

describe("BrandIcon", () => {
  it("renders a glyph for a known name", async () => {
    const { toJSON } = await render(<BrandIcon name="nav" />);
    const tree = toJSON();
    expect(tree).toBeTruthy();
    // The root is the Svg stub and it has at least one child path.
    expect(JSON.stringify(tree)).toContain("Path");
  });

  it("renders without throwing for every icon in the set", async () => {
    const names = [
      "home",
      "roads",
      "route",
      "user",
      "gauge",
      "alert",
      "bolt",
      "flag",
      "mountain",
      "share",
      "layers",
      "filter",
      "pin",
      "nav",
      "settings",
      "grid",
      "phone",
      "heart",
      "sun",
      "moon",
    ] as const;
    for (const name of names) {
      await expect(render(<BrandIcon name={name} />)).resolves.toBeDefined();
    }
  });
});
