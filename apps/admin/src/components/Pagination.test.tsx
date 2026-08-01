import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Pagination } from "./Pagination.js";

describe("Pagination", () => {
  it("shows the page position and the total row count", () => {
    render(
      <Pagination page={2} pageCount={5} total={104} onPageChange={vi.fn()} />,
    );
    expect(screen.getByText("Page 2 of 5 (104 total)")).toBeInTheDocument();
  });

  it("steps back and forward one page", async () => {
    const onPageChange = vi.fn();
    render(
      <Pagination
        page={3}
        pageCount={5}
        total={104}
        onPageChange={onPageChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Prev" }));
    expect(onPageChange).toHaveBeenCalledWith(2);

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(4);
  });

  it("disables Prev on the first page and Next on the last", () => {
    const { unmount } = render(
      <Pagination page={1} pageCount={3} total={7} onPageChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Prev" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    unmount();

    render(
      <Pagination page={3} pageCount={3} total={7} onPageChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Prev" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("disables both controls on a single page", () => {
    render(
      <Pagination page={1} pageCount={1} total={3} onPageChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Prev" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});
