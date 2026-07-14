import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select } from "../Select";

const OPTIONS = [
  { value: "any", label: "Any" },
  { value: "good", label: "Good or better" },
  { value: "excellent", label: "Excellent only" },
];

test("renders the selected value and reports changes by value", async () => {
  const onChange = vi.fn();
  render(
    <Select
      ariaLabel="quality"
      value="good"
      onChange={onChange}
      options={OPTIONS}
    />,
  );
  // closed field shows the selected label
  expect(
    screen.getByRole("button", { name: /Good or better/ }),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button"));
  await userEvent.click(screen.getByRole("option", { name: "Excellent only" }));
  expect(onChange).toHaveBeenCalledWith("excellent");
});

test("marks the current option selected", async () => {
  render(
    <Select
      ariaLabel="quality"
      value="good"
      onChange={() => {}}
      options={OPTIONS}
    />,
  );
  await userEvent.click(screen.getByRole("button"));
  expect(
    screen.getByRole("option", { name: "Good or better" }),
  ).toHaveAttribute("aria-selected", "true");
});

test("disabled prevents opening", async () => {
  render(
    <Select
      ariaLabel="q"
      value="any"
      onChange={() => {}}
      options={OPTIONS}
      disabled
    />,
  );
  expect(screen.getByRole("button")).toBeDisabled();
});
