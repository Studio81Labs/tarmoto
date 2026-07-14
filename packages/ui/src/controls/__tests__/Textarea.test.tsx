import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Textarea } from "../Textarea";
import { Field } from "../field/Field";

test("edits flow through onChange", async () => {
  const onChange = vi.fn();
  render(<Textarea value="" onChange={onChange} ariaLabel="desc" />);
  await userEvent.type(screen.getByRole("textbox", { name: "desc" }), "S");
  expect(onChange).toHaveBeenCalledWith("S");
});

test("hint renders and associates via aria-describedby", () => {
  render(
    <Textarea id="d" value="" onChange={() => {}} hint="Markdown supported." />,
  );
  const ta = screen.getByRole("textbox");
  expect(ta).toHaveAttribute(
    "aria-describedby",
    screen.getByText("Markdown supported.").id,
  );
});

test("error sets aria-invalid", () => {
  render(<Textarea value="" onChange={() => {}} ariaLabel="d" error />);
  expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
});

test("associates the hint for an ariaLabel-only field with no id", () => {
  render(
    <Textarea
      value=""
      onChange={() => {}}
      ariaLabel="Notes"
      hint="Markdown supported."
    />,
  );
  const ta = screen.getByRole("textbox", { name: "Notes" });
  const hint = screen.getByText("Markdown supported.");
  expect(hint.id).toBeTruthy();
  expect(ta).toHaveAttribute("aria-describedby", hint.id);
});

test("honors an external hintId with no local hint (Field composition)", () => {
  // Field renders the hint itself and passes only `hintId` to the child.
  render(
    <Field id="notes" label="Notes" hint="Markdown supported.">
      {({ id, hintId, error }) => (
        <Textarea
          id={id}
          hintId={hintId}
          error={error}
          value=""
          onChange={() => {}}
        />
      )}
    </Field>,
  );
  const ta = screen.getByLabelText("Notes");
  expect(ta).toHaveAttribute(
    "aria-describedby",
    screen.getByText("Markdown supported.").id,
  );
});
