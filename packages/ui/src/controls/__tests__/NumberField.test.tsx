import { render, screen, fireEvent } from "@testing-library/react";
import { NumberField } from "../NumberField";

test("clamps and reports numeric changes", async () => {
  const onChange = vi.fn();
  render(
    <NumberField
      value={50}
      onChange={onChange}
      min={0}
      max={999}
      ariaLabel="km"
    />,
  );
  const input = screen.getByRole("spinbutton", {
    name: "km",
  }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "300" } });
  expect(onChange).toHaveBeenCalledWith(300);
});

test("renders a decorative unit adornment", () => {
  render(
    <NumberField
      value={250}
      onChange={() => {}}
      min={0}
      max={999}
      ariaLabel="km"
      unit="KM"
    />,
  );
  const unit = screen.getByText("KM");
  expect(unit).toHaveAttribute("aria-hidden", "true");
});
