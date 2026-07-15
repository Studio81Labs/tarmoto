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
    screen.getByRole("button", { name: /ride start/i }),
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

test("changing the hour snaps an off-step minute to the nearest step", async () => {
  // minuteStep=15 (default); initial value "2026-05-18T08:20" — 20 is not a multiple of 15.
  // snapMinute(20) = Math.min(Math.round(20/15), 3) * 15 = Math.min(1, 3) * 15 = 15
  const expectedMinute = 15;
  const onChange = vi.fn();
  function Wrapper() {
    const [v, setV] = useState("2026-05-18T08:20");
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
  await userEvent.click(screen.getByRole("button", { name: /ride start/i }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Increase hour" }),
  );
  const expected = `2026-05-18T09:${String(expectedMinute).padStart(2, "0")}`;
  expect(onChange).toHaveBeenLastCalledWith(expected);
});

test("error exposes an invalid description to assistive tech", () => {
  render(
    <DateTimePicker
      ariaLabel="Ride start"
      value=""
      onChange={() => {}}
      error
    />,
  );
  const trigger = screen.getByRole("button", { name: "Ride start" });
  const desc = screen.getByText("Invalid date-time");
  expect(desc).toHaveClass("sr-only");
  expect(trigger).toHaveAttribute("aria-describedby", desc.id);
});

test("minute stepper can reach minute 45 with minuteStep=45", async () => {
  const onChange = vi.fn();
  function Wrapper() {
    const [v, setV] = useState("2026-05-18T08:00");
    return (
      <DateTimePicker
        ariaLabel="Ride start"
        value={v}
        minuteStep={45}
        onChange={(nv) => {
          onChange(nv);
          setV(nv);
        }}
      />
    );
  }
  render(<Wrapper />);
  await userEvent.click(screen.getByRole("button", { name: /ride start/i }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Increase minute" }),
  );
  expect(onChange).toHaveBeenLastCalledWith("2026-05-18T08:45");
});

test("trigger accessible name includes the value when ariaLabel is set", () => {
  render(
    <DateTimePicker
      ariaLabel="Ride start"
      value="2026-05-18T08:30"
      onChange={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: /08:30/ })).toBeInTheDocument();
});

test("trigger accessible name includes the value when label is set", () => {
  render(
    <DateTimePicker
      label="Ride start"
      value="2026-05-18T08:30"
      onChange={() => {}}
    />,
  );
  const btn = screen.getByRole("button", { name: /ride start/i });
  expect(btn).toBeInTheDocument();
  expect(btn).toHaveAccessibleName(expect.stringContaining("08:30"));
});
