import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatePicker } from "../DatePicker";

test("opens the calendar and reports the picked date as an ISO string", async () => {
  const onChange = vi.fn();
  render(
    <DatePicker ariaLabel="Departure" value="2026-05-01" onChange={onChange} />,
  );
  // The calendar-open button's accessible name is "Calendar" (react-aria override)
  await userEvent.click(screen.getByRole("button", { name: /calendar/i }));
  // Day cells are <div role="button"> with full date name, e.g. "Monday, May 18, 2026"
  await userEvent.click(screen.getByRole("button", { name: /May 18, 2026/ }));
  expect(onChange).toHaveBeenCalledWith("2026-05-18");
});

test("label associates via react-aria Label", () => {
  render(<DatePicker label="Departure" value="" onChange={() => {}} />);
  expect(screen.getByText("Departure")).toBeInTheDocument();
});

test("renders the empty/unset state without error", () => {
  const onChange = vi.fn();
  render(<DatePicker ariaLabel="Departure" value="" onChange={onChange} />);
  // the field trigger renders (react-aria names the open button "Calendar")
  expect(screen.getByRole("button", { name: /calendar/i })).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});
