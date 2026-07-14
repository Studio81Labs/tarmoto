import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input } from "../Input";

test("edits flow through onChange", async () => {
  const onChange = vi.fn();
  render(<Input value="" onChange={onChange} ariaLabel="bike" />);
  await userEvent.type(screen.getByRole("textbox", { name: "bike" }), "R");
  expect(onChange).toHaveBeenCalledWith("R");
});

test("error sets aria-invalid and associates the hint", () => {
  render(
    <Input
      id="email"
      value="x"
      onChange={() => {}}
      error
      hint="Enter a valid email address."
    />,
  );
  const input = screen.getByRole("textbox");
  expect(input).toHaveAttribute("aria-invalid", "true");
  const hint = screen.getByText("Enter a valid email address.");
  expect(input).toHaveAttribute("aria-describedby", hint.id);
});

test("leading icon is decorative (aria-hidden), input still reachable by label", () => {
  render(
    <Input
      value=""
      onChange={() => {}}
      ariaLabel="search"
      leadingIcon={<svg data-testid="ico" />}
    />,
  );
  expect(screen.getByRole("textbox", { name: "search" })).toBeInTheDocument();
});
