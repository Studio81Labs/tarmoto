import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DatePicker,
  Group,
  Button,
  Popover,
  Dialog,
  Calendar,
  CalendarGrid,
  CalendarCell,
  Heading,
} from "react-aria-components";
import { parseDate } from "@internationalized/date";

test("react-aria DatePicker opens a calendar and selects a day", async () => {
  const onChange = vi.fn();
  render(
    <DatePicker
      aria-label="d"
      defaultValue={parseDate("2026-05-01")}
      onChange={onChange}
    >
      <Group>
        <Button>open</Button>
      </Group>
      <Popover>
        <Dialog>
          <Calendar>
            <header>
              <Button slot="previous">‹</Button>
              <Heading />
              <Button slot="next">›</Button>
            </header>
            <CalendarGrid>
              {(date) => <CalendarCell date={date} />}
            </CalendarGrid>
          </Calendar>
        </Dialog>
      </Popover>
    </DatePicker>,
  );
  await userEvent.click(screen.getByRole("button", { name: /calendar/i }));
  await userEvent.click(screen.getByRole("button", { name: /May 18, 2026/ }));
  expect(onChange).toHaveBeenCalled();
});
