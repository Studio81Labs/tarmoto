import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTimePicker } from "../DateTimePicker";

test("picks a day and keeps the time, emitting ISO datetime", async () => {
  const onChange = vi.fn();
  render(
    <DateTimePicker
      ariaLabel="Ride start"
      value="2026-05-17T08:30"
      onChange={onChange}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /ride start/i }));
  await userEvent.click(screen.getByRole("button", { name: /May 18, 2026/ }));
  expect(onChange).toHaveBeenLastCalledWith("2026-05-18T08:30");
});

test("label-only trigger has an accessible name", () => {
  render(<DateTimePicker label="Ride start" value="" onChange={() => {}} />);
  expect(
    screen.getByRole("button", { name: "Ride start" }),
  ).toBeInTheDocument();
});

test("renders empty state without throwing and does not call onChange", () => {
  const onChange = vi.fn();
  render(
    <DateTimePicker ariaLabel="Ride start" value="" onChange={onChange} />,
  );
  expect(
    screen.getByRole("button", { name: /ride start/i }),
  ).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});
