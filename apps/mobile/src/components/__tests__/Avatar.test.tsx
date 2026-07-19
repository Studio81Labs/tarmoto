import React from "react";
import { render, screen } from "@testing-library/react-native";
import Avatar, { initialsFromName } from "../Avatar";

describe("initialsFromName", () => {
  it("returns first two uppercase initials", () => {
    expect(initialsFromName("Adam Kadlec")).toBe("AK");
  });

  it("trims a single name to one initial", () => {
    expect(initialsFromName("Adam")).toBe("A");
  });

  it("ignores leading whitespace so the empty word doesn't poison the join", () => {
    expect(initialsFromName("  Alice")).toBe("A");
  });

  it("returns ? for empty / whitespace / nullish input", () => {
    expect(initialsFromName("")).toBe("?");
    expect(initialsFromName("   ")).toBe("?");
    expect(initialsFromName(null)).toBe("?");
    expect(initialsFromName(undefined)).toBe("?");
  });
});

describe("Avatar", () => {
  it("renders an image when a uri is provided", async () => {
    await render(
      <Avatar uri="https://example.com/avatar.png" name="Adam Kadlec" />,
    );
    const image = screen.getByLabelText("Adam Kadlec avatar");
    expect(image.props.source).toEqual({
      uri: "https://example.com/avatar.png",
    });
    expect(image.props.accessibilityLabel).toBe("Adam Kadlec avatar");
  });

  it("renders the initials fallback when no uri is provided", async () => {
    await render(<Avatar name="Adam Kadlec" />);
    expect(screen.getByText("AK")).toBeTruthy();
  });

  it("renders the fallback for null uri", async () => {
    await render(<Avatar uri={null} name="Jane Doe" />);
    expect(screen.getByText("JD")).toBeTruthy();
  });
});
