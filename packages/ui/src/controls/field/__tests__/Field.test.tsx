import { render, screen } from "@testing-library/react";
import { Field } from "../Field";
import { Input } from "../../Input";

test("wires label + hint + error to the rendered control", () => {
  render(
    <Field id="email" label="Email" hint="Enter a valid email address." error>
      {({ id, hintId, error }) => (
        <Input
          id={id}
          hintId={hintId}
          error={error}
          value="x"
          onChange={() => {}}
        />
      )}
    </Field>,
  );
  const input = screen.getByLabelText("Email");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAttribute(
    "aria-describedby",
    screen.getByText("Enter a valid email address.").id,
  );
});
