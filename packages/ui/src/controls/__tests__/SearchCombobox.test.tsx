import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchCombobox } from "../SearchCombobox";

const ITEMS = [
  { value: "brno", label: "Brno, Czechia" },
  { value: "tatra", label: "Tatra Mountains, Slovakia" },
];

test("typing reports query changes and opens the listbox at minChars", async () => {
  const onQueryChange = vi.fn();
  const { rerender } = render(
    <SearchCombobox
      ariaLabel="Place"
      query=""
      onQueryChange={onQueryChange}
      items={[]}
      onSelect={() => {}}
    />,
  );
  const input = screen.getByRole("combobox", { name: "Place" });
  await userEvent.type(input, "b");
  expect(onQueryChange).toHaveBeenCalledWith("b");
  // One char is below the default minChars=2 — no menu yet.
  expect(input).toHaveAttribute("aria-expanded", "false");

  rerender(
    <SearchCombobox
      ariaLabel="Place"
      query="br"
      onQueryChange={onQueryChange}
      items={ITEMS}
      onSelect={() => {}}
    />,
  );
  expect(input).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("option", { name: "Brno, Czechia" })).toBeVisible();
});

test("clicking an option selects it and closes the menu", async () => {
  const onSelect = vi.fn();
  render(
    <SearchCombobox
      ariaLabel="Place"
      query="ta"
      onQueryChange={() => {}}
      items={ITEMS}
      onSelect={onSelect}
    />,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Place" }));
  await userEvent.click(
    screen.getByRole("option", { name: "Tatra Mountains, Slovakia" }),
  );
  expect(onSelect).toHaveBeenCalledWith("tatra");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

test("arrow keys move the active option and Enter selects it", async () => {
  const onSelect = vi.fn();
  render(
    <SearchCombobox
      ariaLabel="Place"
      query="ta"
      onQueryChange={() => {}}
      items={ITEMS}
      onSelect={onSelect}
    />,
  );
  const input = screen.getByRole("combobox", { name: "Place" });
  await userEvent.click(input);
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(onSelect).toHaveBeenCalledWith("tatra");
});

test("Escape closes the menu", async () => {
  render(
    <SearchCombobox
      ariaLabel="Place"
      query="ta"
      onQueryChange={() => {}}
      items={ITEMS}
      onSelect={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Place" }));
  expect(screen.getByRole("listbox")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

test("loading and empty states render their rows", async () => {
  const { rerender } = render(
    <SearchCombobox
      ariaLabel="Place"
      query="ta"
      onQueryChange={() => {}}
      items={[]}
      onSelect={() => {}}
      loading
    />,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Place" }));
  expect(screen.getByText("Searching…")).toBeVisible();

  rerender(
    <SearchCombobox
      ariaLabel="Place"
      query="ta"
      onQueryChange={() => {}}
      items={[]}
      onSelect={() => {}}
    />,
  );
  expect(screen.getByText("No matches")).toBeVisible();
});

test("clear button appears with a query and fires onClear", async () => {
  const onClear = vi.fn();
  render(
    <SearchCombobox
      ariaLabel="Place"
      query="brno"
      onQueryChange={() => {}}
      items={[]}
      onSelect={() => {}}
      onClear={onClear}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(onClear).toHaveBeenCalledTimes(1);
});

test("renders the trailing adornment inside the field", () => {
  render(
    <SearchCombobox
      ariaLabel="Place"
      query=""
      onQueryChange={() => {}}
      items={[]}
      onSelect={() => {}}
      trailing={<span data-testid="radius-chip">25 KM</span>}
    />,
  );
  expect(screen.getByTestId("radius-chip")).toBeInTheDocument();
});
