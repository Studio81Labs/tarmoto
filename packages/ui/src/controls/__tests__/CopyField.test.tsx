import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyField } from "../CopyField";

test("renders the read-only value and copies it to the clipboard", async () => {
  const onCopied = vi.fn();
  // userEvent.setup installs a working clipboard stub in jsdom.
  const user = userEvent.setup();
  render(
    <CopyField
      value="https://tarmoto.app/join/abc"
      ariaLabel="Invite URL"
      onCopied={onCopied}
    />,
  );
  const input = screen.getByLabelText("Invite URL");
  expect(input).toHaveValue("https://tarmoto.app/join/abc");
  expect(input).toHaveAttribute("readonly");

  await user.click(screen.getByRole("button", { name: "Copy" }));
  expect(onCopied).toHaveBeenCalledTimes(1);
  expect(await window.navigator.clipboard.readText()).toBe(
    "https://tarmoto.app/join/abc",
  );
  // Transient success state is announced for AT.
  expect(screen.getByText("Copied to clipboard")).toBeInTheDocument();
});

test("focusing the field selects the whole value for manual copy", async () => {
  const user = userEvent.setup();
  render(<CopyField value="select-me" ariaLabel="Share link" />);
  const input = screen.getByLabelText<HTMLInputElement>("Share link");
  await user.click(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe("select-me".length);
});
