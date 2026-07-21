import { render, screen } from "@testing-library/react";
import { CollectionRouteRow } from "./collection-route-atoms";
import type { RouteCollectionPreviewItem } from "@/lib/api";
import { createFormatters, type UnitSystem } from "@tarmoto/shared";

function item(
  overrides: Partial<RouteCollectionPreviewItem> = {},
): RouteCollectionPreviewItem {
  return {
    item_id: "item-1",
    position: 0,
    target_id: "ride-1",
    lines: [
      [
        [16.6, 49.2],
        [16.7, 49.15],
      ],
    ],
    title: "Three Passes Sunday",
    distance_km: 242,
    status: "completed",
    quality_avg: 4.4,
    ...overrides,
  };
}

function renderRow(
  route: RouteCollectionPreviewItem,
  props: { linkable?: boolean; units?: UnitSystem } = {},
) {
  const format = createFormatters({
    locale: "en-US",
    units: props.units ?? "metric",
  });
  return render(
    <ul>
      <CollectionRouteRow
        route={route}
        index={1}
        author="Jane Rider"
        format={format}
        linkable={props.linkable}
      />
    </ul>,
  );
}

describe("CollectionRouteRow", () => {
  it("links a ride row to the community ride detail when linkable", () => {
    renderRow(item({ target_id: "ride-1" }), { linkable: true });
    expect(
      screen.getByRole("link", { name: /three passes sunday/i }),
    ).toHaveAttribute("href", "/community/rides/ride-1");
  });

  it("renders a non-interactive row by default (anonymous shared page)", () => {
    renderRow(item());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Three Passes Sunday")).toBeInTheDocument();
    expect(screen.getByText("242 km")).toBeInTheDocument();
  });

  it("formats collection distance in the rider's unit system", () => {
    renderRow(item({ distance_km: 25 }), { units: "imperial" });
    expect(screen.getByText("15.5 mi")).toBeInTheDocument();
    expect(screen.queryByText("25 km")).not.toBeInTheDocument();
  });

  it("stays non-interactive when the underlying entity was deleted (null target)", () => {
    renderRow(item({ target_id: null }), { linkable: true });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("URL-encodes the target id in the detail link", () => {
    renderRow(item({ target_id: "a/b?c#d", title: "Edgey" }), {
      linkable: true,
    });
    expect(screen.getByRole("link", { name: /edgey/i })).toHaveAttribute(
      "href",
      "/community/rides/a%2Fb%3Fc%23d",
    );
  });
});
