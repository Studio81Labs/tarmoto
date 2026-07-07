import { fireEvent, render, screen } from "@testing-library/react";
import { api } from "@/lib/api";
import { SharedRideEmbedWidget } from "./SharedRideEmbedWidget";

vi.mock("@/lib/api", () => ({ api: { POST: vi.fn() } }));
const post = vi.mocked(api.POST);

describe("SharedRideEmbedWidget", () => {
  beforeEach(() => {
    post.mockClear();
  });

  it("renders a shared ride mini-widget and tracks CTA clicks", () => {
    render(
      <SharedRideEmbedWidget
        token="abc123"
        ride={{
          rider_name: "John Rider",
          ride_type: "trip",
          started_at: "2026-04-14T09:00:00.000Z",
          distance_km: 312.4,
          duration_min: 285,
          avg_road_quality: 4.4,
          avg_curviness: 3.7,
          route_geometry: [
            { lat: 49.2, lng: 16.6 },
            { lat: 49.15, lng: 16.7 },
            { lat: 49.1, lng: 16.75 },
          ],
          view_count: 128,
          embed_click_count: 14,
        }}
        pageUrl="https://tarmoto.app/rides/shared/abc123"
        variant="compact"
      />,
    );

    expect(screen.getByText("John Rider")).toBeInTheDocument();
    expect(screen.getByText("312.4 km")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "View full ride" }));

    expect(post).toHaveBeenCalledWith(
      "/api/v1/rides/shared/{token}/embed-click",
      {
        params: { path: { token: "abc123" } },
        keepalive: true,
      },
    );
  });
});
