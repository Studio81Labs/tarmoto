import { render, screen } from "@testing-library/react";
import { Toggle } from "../Toggle";

test("harness renders an existing control", () => {
  render(<Toggle checked={false} onChange={() => {}} ariaLabel="demo" />);
  expect(screen.getByRole("switch", { name: "demo" })).toBeInTheDocument();
});
