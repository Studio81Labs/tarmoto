import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Combobox } from "../Combobox";

const CITIES = [
  { value: "prague", label: "Prague, CZ" },
  { value: "prachatice", label: "Prachatice, CZ" },
  { value: "ostrava", label: "Ostrava, CZ" },
];

test("resyncs input text when controlled value changes externally", async () => {
  function Wrapper() {
    const [value, setValue] = useState("prague");
    return (
      <>
        <Combobox
          ariaLabel="region"
          value={value}
          onChange={setValue}
          options={CITIES}
        />
        <button onClick={() => setValue("")}>Reset</button>
      </>
    );
  }
  render(<Wrapper />);
  const input = screen.getByRole("combobox", { name: "region" });
  // Initially shows the selected option's label
  expect(input).toHaveValue("Prague, CZ");
  // Simulate an external reset (parent clears value)
  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(input).toHaveValue("");
});

test("label prop associates with the combobox input via react-aria Label", () => {
  render(
    <Combobox
      label="Home city"
      value="prague"
      onChange={() => {}}
      options={CITIES}
    />,
  );
  expect(
    screen.getByRole("combobox", { name: "Home city" }),
  ).toBeInTheDocument();
});

test("filters options as the user types and selects by value", async () => {
  const onChange = vi.fn();
  render(
    <Combobox
      ariaLabel="region"
      value=""
      onChange={onChange}
      options={CITIES}
    />,
  );
  const input = screen.getByRole("combobox", { name: "region" });
  await userEvent.type(input, "Pra");
  // Ostrava filtered out; the two Pra* remain
  expect(
    screen.getByRole("option", { name: "Prague, CZ" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Ostrava, CZ" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("option", { name: "Prague, CZ" }));
  expect(onChange).toHaveBeenCalledWith("prague");
});

test("populates the input once options resolve the selected key after mount", () => {
  const { rerender } = render(
    <Combobox
      ariaLabel="region"
      value="prague"
      onChange={() => {}}
      options={[]}
    />,
  );
  const input = screen.getByRole("combobox", { name: "region" });
  // Options haven't loaded — nothing to display yet.
  expect(input).toHaveValue("");
  // Options arrive and now resolve the selected key.
  rerender(
    <Combobox
      ariaLabel="region"
      value="prague"
      onChange={() => {}}
      options={CITIES}
    />,
  );
  expect(input).toHaveValue("Prague, CZ");
});

test("marks an empty-string sentinel option as selected", async () => {
  const OPTS = [
    { value: "", label: "Any" },
    { value: "3", label: "3 stars" },
  ];
  render(
    <Combobox ariaLabel="rating" value="" onChange={() => {}} options={OPTS} />,
  );
  await userEvent.click(screen.getByRole("button", { hidden: true }));
  // The "" sentinel is a real selection, so react-aria marks it selected.
  expect(screen.getByRole("option", { name: "Any" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("opening with a value shows all options to browse (not just the selection)", async () => {
  render(
    <Combobox
      ariaLabel="region"
      value="prague"
      onChange={() => {}}
      options={CITIES}
    />,
  );
  // Open via the disclosure arrow without typing. It's intentionally
  // `aria-hidden` (decorative — the input is the real combobox), so query it
  // explicitly with `hidden: true`.
  await userEvent.click(screen.getByRole("button", { hidden: true }));
  // The whole list is browsable, not filtered down to the selected label.
  expect(
    screen.getByRole("option", { name: "Prague, CZ" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("option", { name: "Ostrava, CZ" }),
  ).toBeInTheDocument();
});

test("keeps the search highlight readable on the selected (ink) row", async () => {
  const { rerender } = render(
    <Combobox
      ariaLabel="region"
      value="prague"
      onChange={() => {}}
      options={CITIES}
    />,
  );
  const input = screen.getByRole("combobox", { name: "region" });
  await userEvent.clear(input);
  await userEvent.type(input, "Pra");
  // react-aria caches item content by option identity; pass a fresh identity so
  // the highlight re-renders with the active filter (mirrors a caller that
  // rebuilds options as the query changes).
  rerender(
    <Combobox
      ariaLabel="region"
      value="prague"
      onChange={() => {}}
      options={CITIES.map((c) => ({ ...c }))}
    />,
  );
  // Prague stays the selected key, so its row is ink-filled. The matched "Pra"
  // highlight must use cream — the default ink text would be invisible
  // dark-on-dark.
  const selectedOption = screen.getByRole("option", { selected: true });
  const mark = within(selectedOption).getByText("Pra");
  expect(mark).toHaveClass("text-cream");
  expect(mark).not.toHaveClass("text-ink");
});

test("opens the options list on click/focus without typing", async () => {
  render(
    <Combobox
      ariaLabel="region"
      value=""
      onChange={() => {}}
      options={CITIES}
    />,
  );
  const input = screen.getByRole("combobox", { name: "region" });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await userEvent.click(input);
  expect(screen.getByRole("listbox")).toBeInTheDocument();
});

test("the options list is scrollable (height-capped with overflow)", async () => {
  render(
    <Combobox
      ariaLabel="region"
      value=""
      onChange={() => {}}
      options={CITIES}
    />,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "region" }));
  const list = screen.getByRole("listbox");
  expect(list.className).toMatch(/overflow-auto/);
  expect(list.className).toMatch(/max-h-/);
});
