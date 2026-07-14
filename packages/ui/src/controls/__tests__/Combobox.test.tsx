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
