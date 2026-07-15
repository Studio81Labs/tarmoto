import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { TimePicker } from "../TimePicker";

/** Stateful wrapper so the controlled value compounds across sequential picks. */
function ControlledTimePicker({
  initialValue,
  onChange,
  minuteStep,
}: {
  initialValue: string;
  onChange: (v: string) => void;
  minuteStep?: number;
}) {
  const [v, setV] = useState(initialValue);
  return (
    <TimePicker
      ariaLabel="Start time"
      value={v}
      {...(minuteStep !== undefined ? { minuteStep } : {})}
      onChange={(nv) => {
        onChange(nv);
        setV(nv);
      }}
    />
  );
}

test("picks an hour and minute and emits ISO HH:MM", async () => {
  const onChange = vi.fn();
  render(<ControlledTimePicker initialValue="08:30" onChange={onChange} />);

  // Open the picker
  await userEvent.click(
    screen.getByRole("button", { name: /start time|08:30|time/i }),
  );

  // Pick hour "09" — unique to 00–23 column
  await userEvent.click(screen.getByRole("option", { name: "09" }));
  expect(onChange).toHaveBeenLastCalledWith("09:30");

  // Pick minute "45" — unique to 00/15/30/45 column
  await userEvent.click(screen.getByRole("option", { name: "45" }));
  expect(onChange).toHaveBeenLastCalledWith("09:45");
});

test("minute options reflect minuteStep", async () => {
  render(
    <TimePicker
      ariaLabel="t"
      value="00:00"
      minuteStep={15}
      onChange={() => {}}
    />,
  );

  // Open the picker to see options
  await userEvent.click(screen.getByRole("button", { name: /t|00:00|time/i }));

  // Scope to the MIN listbox to avoid collision with the HR column's "00" option
  const minList = screen.getByRole("listbox", { name: "MIN" });
  expect(
    within(minList).getByRole("option", { name: "00" }),
  ).toBeInTheDocument();
  expect(
    within(minList).getByRole("option", { name: "15" }),
  ).toBeInTheDocument();
  expect(
    within(minList).getByRole("option", { name: "30" }),
  ).toBeInTheDocument();
  expect(
    within(minList).getByRole("option", { name: "45" }),
  ).toBeInTheDocument();
  // Non-step minute must not exist in the MIN column
  expect(
    within(minList).queryByRole("option", { name: "10" }),
  ).not.toBeInTheDocument();
});

test("trigger button has accessible name from label prop", () => {
  render(<TimePicker label="Start time" value="" onChange={() => {}} />);
  expect(
    screen.getByRole("button", { name: /start time/i }),
  ).toBeInTheDocument();
});

test("renders empty state without throwing and does not call onChange", () => {
  const onChange = vi.fn();
  render(<TimePicker ariaLabel="Start time" value="" onChange={onChange} />);
  // Trigger button renders without crashing; shows "Select time"
  expect(
    screen.getByRole("button", { name: /start time|select time|time/i }),
  ).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});

test("changing the hour snaps an off-step minute to the nearest step", async () => {
  // minuteStep=15; initial value "08:20" — 20 is not a multiple of 15.
  // snapMinute(20) = Math.min(Math.round(20/15), 3) * 15 = Math.min(1, 3) * 15 = 15
  const expectedMinute = 15;
  const onChange = vi.fn();
  function Wrapper() {
    const [v, setV] = useState("08:20");
    return (
      <TimePicker
        ariaLabel="Start time"
        value={v}
        minuteStep={15}
        onChange={(nv) => {
          onChange(nv);
          setV(nv);
        }}
      />
    );
  }
  render(<Wrapper />);
  await userEvent.click(
    screen.getByRole("button", { name: /start time|08:20|time/i }),
  );
  // Pick hour 09 — should snap the minute from 20 → 15
  await userEvent.click(screen.getByRole("option", { name: "09" }));
  expect(onChange).toHaveBeenLastCalledWith(
    `09:${String(expectedMinute).padStart(2, "0")}`,
  );
});

test("error exposes an invalid description to assistive tech", () => {
  render(
    <TimePicker ariaLabel="Start time" value="" onChange={() => {}} error />,
  );
  const trigger = screen.getByRole("button", { name: "Start time" });
  const desc = screen.getByText("Invalid time");
  expect(desc).toHaveClass("sr-only");
  expect(trigger).toHaveAttribute("aria-describedby", desc.id);
});

test("non-dividing minuteStep=45 exposes the 45 option in the MIN listbox", async () => {
  render(
    <TimePicker
      ariaLabel="t"
      value="00:00"
      minuteStep={45}
      onChange={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /t|00:00|time/i }));
  const minList = screen.getByRole("listbox", { name: "MIN" });
  expect(
    within(minList).getByRole("option", { name: "00" }),
  ).toBeInTheDocument();
  expect(
    within(minList).getByRole("option", { name: "45" }),
  ).toBeInTheDocument();
  // Only two options: 0 and 45
  expect(within(minList).getAllByRole("option")).toHaveLength(2);
});

test("trigger accessible name includes the value when ariaLabel is set", () => {
  render(
    <TimePicker ariaLabel="Start time" value="08:30" onChange={() => {}} />,
  );
  expect(screen.getByRole("button", { name: /08:30/ })).toBeInTheDocument();
});

test("trigger accessible name includes the value when label is set", () => {
  render(
    <TimePicker label="Departure time" value="08:30" onChange={() => {}} />,
  );
  // Name comes from aria-labelledby = label + value span; should contain both
  const btn = screen.getByRole("button", { name: /departure time/i });
  expect(btn).toBeInTheDocument();
  expect(btn).toHaveAccessibleName(expect.stringContaining("08:30"));
});

test("guards an invalid minuteStep (0) without hanging", () => {
  render(
    <TimePicker
      ariaLabel="Start time"
      value=""
      minuteStep={0}
      onChange={() => {}}
    />,
  );
  // Falls back to the default step; renders (an infinite loop would time out).
  expect(
    screen.getByRole("button", { name: /start time/i }),
  ).toBeInTheDocument();
});
