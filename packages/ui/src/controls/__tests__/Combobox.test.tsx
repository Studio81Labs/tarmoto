import { render, screen } from "@testing-library/react";
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
