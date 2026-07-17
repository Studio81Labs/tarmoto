import { render, screen } from "@testing-library/react";
import {
  PageLoadingBar,
  Skeleton,
  SkeletonDashboard,
  SkeletonForm,
  SkeletonGrid,
  SkeletonList,
} from "../Skeleton";

test("skeleton blocks and the loading bar are hidden from assistive tech", () => {
  const { container } = render(
    <div>
      <Skeleton className="h-4 w-20" />
      <PageLoadingBar />
    </div>,
  );
  for (const node of container.querySelectorAll("div > div")) {
    if (node.getAttribute("aria-hidden") !== null) {
      expect(node).toHaveAttribute("aria-hidden", "true");
    }
  }
  expect(container.querySelectorAll('[aria-hidden="true"]').length).toBe(2);
});

test("list composition renders the requested rows and announces loading", () => {
  const { container } = render(
    <SkeletonList rows={3} label="Loading rides…" />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading rides…");
  // Root children = sr-only status span + one aria-hidden div per row.
  const root = container.firstElementChild!;
  expect(
    root.querySelectorAll(':scope > div[aria-hidden="true"]'),
  ).toHaveLength(3);
});

test("grid composition renders the requested cards", () => {
  const { container } = render(<SkeletonGrid cards={5} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading…");
  const root = container.firstElementChild!;
  expect(
    root.querySelectorAll(':scope > div[aria-hidden="true"]'),
  ).toHaveLength(5);
});

test("form composition renders the requested section cards", () => {
  const { container } = render(
    <SkeletonForm sections={3} label="Loading settings…" />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading settings…");
  const root = container.firstElementChild!;
  expect(
    root.querySelectorAll(':scope > div[aria-hidden="true"]'),
  ).toHaveLength(3);
});

test("dashboard composition renders KPI tiles and chart cards", () => {
  const { container } = render(<SkeletonDashboard />);
  expect(screen.getByRole("status")).toBeInTheDocument();
  // 4 KPI tiles + 1 wide chart + 2 half cards = 3 aria-hidden sections.
  expect(
    container.querySelectorAll(':scope > div > [aria-hidden="true"]'),
  ).not.toHaveLength(0);
});
