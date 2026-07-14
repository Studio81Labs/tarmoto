import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Combobox } from "../Combobox";

const CITIES = [
  { value: "prague", label: "Prague, CZ" },
  { value: "prachatice", label: "Prachatice, CZ" },
  { value: "ostrava", label: "Ostrava, CZ" },
];

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
