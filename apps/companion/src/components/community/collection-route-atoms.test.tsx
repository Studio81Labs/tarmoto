import { render, screen } from "@testing-library/react";
import { CollectionRouteRow } from "./collection-route-atoms";
import type { RouteCollectionPreviewItem } from "@/lib/api";

function item(
  overrides: Partial<RouteCollectionPreviewItem> = {},
): RouteCollectionPreviewItem {
  return {
    item_id: "item-1",
    position: 0,
    kind: "ride",
    target_id: "ride-1",
    lines: [
      [
        [16.6, 49.2],
        [16.7, 49.15],
      ],
    ],
    title: "Three Passes Sunday",
    num_days: null,
    distance_km: 242,
    status: "completed",
    quality_avg: 4.4,
    ...overrides,
  };
}

function renderRow(
  route: RouteCollectionPreviewItem,
  props: { linkable?: boolean } = {},
) {
  return render(
    <ul>
      <CollectionRouteRow
        route={route}
        index={1}
        author="Jane Rider"
        linkable={props.linkable}
      />
    </ul>,
  );
}

describe("CollectionRouteRow", () => {
  it("links a ride row to the community ride detail when linkable", () => {
    renderRow(item({ kind: "ride", target_id: "ride-1" }), { linkable: true });
    expect(
      screen.getByRole("link", { name: /three passes sunday/i }),
    ).toHaveAttribute("href", "/community/rides/ride-1");
  });

  it("links a trip row to the community trip detail when linkable", () => {
    renderRow(item({ kind: "trip", target_id: "trip-9", title: "Dolomites" }), {
      linkable: true,
    });
    expect(screen.getByRole("link", { name: /dolomites/i })).toHaveAttribute(
      "href",
      "/community/trips/trip-9",
    );
  });

  it("renders a non-interactive row by default (anonymous shared page)", () => {
    renderRow(item());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Three Passes Sunday")).toBeInTheDocument();
  });

  it("stays non-interactive when the underlying entity was deleted (null target)", () => {
    renderRow(item({ target_id: null }), { linkable: true });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("URL-encodes the target id in the detail link", () => {
    renderRow(item({ kind: "trip", target_id: "a/b?c#d", title: "Edgey" }), {
      linkable: true,
    });
    expect(screen.getByRole("link", { name: /edgey/i })).toHaveAttribute(
      "href",
      "/community/trips/a%2Fb%3Fc%23d",
    );
  });
});
