import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Select,
  Button,
  SelectValue,
  Popover,
  ListBox,
  ListBoxItem,
} from "react-aria-components";

test("react-aria Select opens and selects by key", async () => {
  const onSelectionChange = vi.fn();
  render(
    <Select aria-label="demo" onSelectionChange={onSelectionChange}>
      <Button>
        <SelectValue />
      </Button>
      <Popover>
        <ListBox>
          <ListBoxItem id="a">Alpha</ListBoxItem>
          <ListBoxItem id="b">Bravo</ListBoxItem>
        </ListBox>
      </Popover>
    </Select>,
  );
  await userEvent.click(screen.getByRole("button"));
  await userEvent.click(screen.getByRole("option", { name: "Bravo" }));
  expect(onSelectionChange).toHaveBeenCalledWith("b");
});
