import { render, screen } from "@testing-library/react";
import { FieldLabel } from "../FieldLabel";
import { FieldHint } from "../FieldHint";

test("FieldLabel renders a <label> bound to a field id", () => {
  render(<FieldLabel htmlFor="x">Departure</FieldLabel>);
  const label = screen.getByText("Departure");
  expect(label.tagName).toBe("LABEL");
  expect(label).toHaveAttribute("for", "x");
});

test("FieldHint default vs error tone", () => {
  const { rerender } = render(<FieldHint id="h">Markdown supported</FieldHint>);
  expect(screen.getByText("Markdown supported")).toHaveAttribute("id", "h");
  rerender(
    <FieldHint id="h" tone="error">
      Enter a valid email address.
    </FieldHint>,
  );
  expect(screen.getByText("Enter a valid email address.").className).toContain(
    "text-quality-q1",
  );
});
