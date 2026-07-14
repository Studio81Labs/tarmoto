import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BlockCard } from "./BlockCard.js";

describe("BlockCard", () => {
  it("edits a paragraph's text", () => {
    const onChange = vi.fn();
    render(
      <BlockCard
        block={{ type: "paragraph", text: "hi" }}
        index={0}
        total={2}
        textVars={["displayName"]}
        urlVars={["exploreUrl"]}
        onChange={onChange}
        onMove={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/text/i), {
      target: { value: "hey {displayName}" },
    });
    expect(onChange).toHaveBeenCalledWith({
      type: "paragraph",
      text: "hey {displayName}",
    });
  });

  it("appends a var via a chip", () => {
    const onChange = vi.fn();
    render(
      <BlockCard
        block={{ type: "paragraph", text: "hi " }}
        index={0}
        total={2}
        textVars={["displayName"]}
        urlVars={[]}
        onChange={onChange}
        onMove={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "{displayName}" }));
    expect(onChange).toHaveBeenCalledWith({
      type: "paragraph",
      text: "hi {displayName}",
    });
  });

  it("moves and removes", () => {
    const onMove = vi.fn();
    const onRemove = vi.fn();
    render(
      <BlockCard
        block={{ type: "divider" }}
        index={1}
        total={3}
        textVars={[]}
        urlVars={[]}
        onChange={vi.fn()}
        onMove={onMove}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByLabelText(/move up/i));
    expect(onMove).toHaveBeenCalledWith(-1);
    fireEvent.click(screen.getByLabelText(/remove/i));
    expect(onRemove).toHaveBeenCalled();
  });
});
