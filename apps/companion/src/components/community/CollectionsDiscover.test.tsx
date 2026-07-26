import { render, screen } from "@testing-library/react";
import { t } from "@/i18n";
import { CollectionMetric } from "./CollectionsDiscover";

describe("CollectionMetric", () => {
  it.each([
    { count: 1, formattedCount: "1", kind: "routes", label: "1 ROUTE" },
    {
      count: 2,
      formattedCount: "2",
      kind: "routes",
      label: "2 ROUTES",
    },
    {
      count: 1,
      formattedCount: "1",
      kind: "followers",
      label: "1 FOLLOW",
    },
    {
      count: 2,
      formattedCount: "2",
      kind: "followers",
      label: "2 FOLLOWS",
    },
  ] as const)(
    "renders the cataloged $kind label for count $count with an emphasized count",
    ({ count, formattedCount, kind, label }) => {
      const { container } = render(
        <CollectionMetric
          count={count}
          formattedCount={formattedCount}
          kind={kind}
          t={t}
        />,
      );

      expect(container.textContent).toBe(label);
      expect(screen.getByText(formattedCount)).toHaveClass(
        "font-bold",
        "text-ink",
      );
    },
  );
});
