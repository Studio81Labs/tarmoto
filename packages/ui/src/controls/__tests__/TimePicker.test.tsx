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

test("renders empty state without throwing and does not call onChange", () => {
  const onChange = vi.fn();
  render(<TimePicker ariaLabel="Start time" value="" onChange={onChange} />);
  // Trigger button renders without crashing; shows "Select time"
  expect(
    screen.getByRole("button", { name: /start time|select time|time/i }),
  ).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});
