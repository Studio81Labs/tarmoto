import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

test("stepping the time keeps the date and emits merged ISO", async () => {
  const onChange = vi.fn();
  function Wrapper() {
    const [v, setV] = useState("2026-05-18T08:30");
    return (
      <DateTimePicker
        ariaLabel="Ride start"
        value={v}
        onChange={(nv) => {
          onChange(nv);
          setV(nv);
        }}
      />
    );
  }
  render(<Wrapper />);
  // Steppers are inside the popover — open it first
  await userEvent.click(screen.getByRole("button", { name: /ride start/i }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Increase hour" }),
  );
  expect(onChange).toHaveBeenLastCalledWith("2026-05-18T09:30");
  await userEvent.click(
    screen.getByRole("button", { name: "Increase minute" }),
  );
  expect(onChange).toHaveBeenLastCalledWith("2026-05-18T09:45");
});
