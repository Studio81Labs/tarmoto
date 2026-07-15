import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatePicker } from "../DatePicker";

test("opens the calendar and reports the picked date as an ISO string", async () => {
  const onChange = vi.fn();
  render(
    <DatePicker ariaLabel="Departure" value="2026-05-01" onChange={onChange} />,
  );
  // The trigger button is now named by the field (ariaLabel), not "Calendar"
  await userEvent.click(screen.getByRole("button", { name: /departure/i }));
  // Day cells are <div role="button"> with full date name, e.g. "Monday, May 18, 2026"
  await userEvent.click(screen.getByRole("button", { name: /May 18, 2026/ }));
  expect(onChange).toHaveBeenCalledWith("2026-05-18");
});

test("label gives the trigger button its accessible name", () => {
  render(<DatePicker label="Departure" value="" onChange={() => {}} />);
  expect(
    screen.getByRole("button", { name: /departure/i }),
  ).toBeInTheDocument();
});

test("renders the empty/unset state without error", () => {
  const onChange = vi.fn();
  render(<DatePicker ariaLabel="Departure" value="" onChange={onChange} />);
  // The trigger is now named by ariaLabel, not "Calendar"
  expect(
    screen.getByRole("button", { name: /departure/i }),
  ).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});

test("error exposes an invalid description to assistive tech", () => {
  render(
    <DatePicker ariaLabel="Departure" value="" onChange={() => {}} error />,
  );
  const trigger = screen.getByRole("button", { name: "Departure" });
  const desc = screen.getByText("Invalid date");
  expect(desc).toHaveClass("sr-only");
  expect(trigger).toHaveAttribute("aria-describedby", desc.id);
});

test("trigger accessible name includes the formatted value when ariaLabel is set", () => {
  render(
    <DatePicker
      ariaLabel="Departure"
      value="2026-05-18"
      locale="en-GB"
      onChange={() => {}}
    />,
  );
  expect(
    screen.getByRole("button", { name: /18\/05\/2026/ }),
  ).toBeInTheDocument();
});

test("trigger accessible name includes the formatted value when label is set", () => {
  render(
    <DatePicker
      label="Departure"
      value="2026-05-18"
      locale="en-GB"
      onChange={() => {}}
    />,
  );
  const btn = screen.getByRole("button", { name: /departure/i });
  expect(btn).toBeInTheDocument();
  expect(btn).toHaveAccessibleName(expect.stringContaining("18/05/2026"));
});

test("closes the popover after a day is selected", async () => {
  render(
    <DatePicker ariaLabel="Departure" value="2026-05-01" onChange={() => {}} />,
  );
  await userEvent.click(screen.getByRole("button", { name: /departure/i }));
  // calendar open
  await userEvent.click(screen.getByRole("button", { name: /May 18, 2026/ }));
  // committing the day dismisses the popover — day cells are gone
  expect(
    screen.queryByRole("button", { name: /May 18, 2026/ }),
  ).not.toBeInTheDocument();
});

test("weeks start on Monday regardless of locale", async () => {
  render(
    <DatePicker ariaLabel="Departure" value="2026-05-01" onChange={() => {}} />,
  );
  await userEvent.click(screen.getByRole("button", { name: /departure/i }));
  // §09 mandates M T W T F S S. The grid's first day cell is a Monday;
  // a Sunday-first (locale-default) calendar would start on a Sunday.
  const grid = screen.getByRole("grid");
  const dayCells = within(grid).getAllByRole("button");
  expect(dayCells[0]).toHaveAccessibleName(/^Monday,/);
});

test("clicking the label opens the picker", async () => {
  render(
    <DatePicker label="Departure" value="2026-05-01" onChange={() => {}} />,
  );
  expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  await userEvent.click(screen.getByText("Departure"));
  expect(screen.getByRole("grid")).toBeInTheDocument();
});

test("formatValue controls the trigger display text", () => {
  render(
    <DatePicker
      ariaLabel="Departure"
      value="2026-05-18"
      formatValue={(iso) => `on ${iso.split("-").reverse().join(".")}`}
      onChange={() => {}}
    />,
  );
  expect(screen.getByText("on 18.05.2026")).toBeInTheDocument();
});

test("locale drives the trigger display text", () => {
  render(
    <DatePicker
      ariaLabel="Departure"
      value="2026-05-18"
      locale="de-DE"
      onChange={() => {}}
    />,
  );
  expect(screen.getByText("18.05.2026")).toBeInTheDocument();
});
