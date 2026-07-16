import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PasswordInput, passwordStrength } from "../PasswordInput";

test("renders a password input and reports typed changes", async () => {
  const onChange = vi.fn();
  render(<PasswordInput ariaLabel="Password" value="" onChange={onChange} />);
  const input = screen.getByLabelText("Password");
  expect(input).toHaveAttribute("type", "password");
  await userEvent.type(input, "a");
  expect(onChange).toHaveBeenCalledWith("a");
});

test("show/hide toggle switches the input type and its own label", async () => {
  render(
    <PasswordInput ariaLabel="Password" value="hunter2" onChange={() => {}} />,
  );
  const input = screen.getByLabelText("Password");
  const toggle = screen.getByRole("button", { name: "Show password" });
  expect(toggle).toHaveAttribute("aria-pressed", "false");

  await userEvent.click(toggle);
  expect(input).toHaveAttribute("type", "text");
  expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await userEvent.click(screen.getByRole("button", { name: "Hide password" }));
  expect(input).toHaveAttribute("type", "password");
});

test("strength meter renders the label for the current score", () => {
  const { rerender } = render(
    <PasswordInput
      ariaLabel="Password"
      value="short"
      onChange={() => {}}
      showStrength
    />,
  );
  expect(screen.getByText("Weak")).toBeInTheDocument();

  rerender(
    <PasswordInput
      ariaLabel="Password"
      value="LongPassword12!x"
      onChange={() => {}}
      showStrength
    />,
  );
  expect(screen.getByText("Strong")).toBeInTheDocument();
});

test("no meter is rendered unless showStrength is set", () => {
  render(
    <PasswordInput ariaLabel="Password" value="short" onChange={() => {}} />,
  );
  expect(screen.queryByText("Weak")).not.toBeInTheDocument();
});

test("defaults to current-password autocomplete, overridable for signup", () => {
  const { rerender } = render(
    <PasswordInput ariaLabel="Password" value="" onChange={() => {}} />,
  );
  expect(screen.getByLabelText("Password")).toHaveAttribute(
    "autocomplete",
    "current-password",
  );
  rerender(
    <PasswordInput
      ariaLabel="Password"
      value=""
      onChange={() => {}}
      autoComplete="new-password"
    />,
  );
  expect(screen.getByLabelText("Password")).toHaveAttribute(
    "autocomplete",
    "new-password",
  );
});

describe("passwordStrength heuristic", () => {
  test.each([
    ["", 0],
    ["abc", 1], // under 8 chars is always weak
    ["Ab1!x2", 1], // variety can't rescue a short password
    ["abcdefgh", 2], // 8+ plain
    ["abcdefghijkl", 3], // 12+ plain
    ["Abcdef1h", 3], // 8+ with 3 classes
    ["Abcdefgh1jkl", 4], // 12+ with 3 classes
    ["Abcdef1h!jkl", 4],
  ] as const)("%s → %i", (value, expected) => {
    expect(passwordStrength(value)).toBe(expected);
  });
});
