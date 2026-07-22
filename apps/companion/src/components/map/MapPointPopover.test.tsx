import { render, screen, fireEvent } from "@testing-library/react";
import { MapPointPopover, type MapPoint } from "./MapPointPopover";
import type { Poi } from "@/lib/planner/types";
import type { PlannerClosure } from "@/lib/closures-summary";
import type { MountainPass } from "@/lib/passes-summary";

// PoiDetails reads the preferences store; stub it — its content is tested on
// its own. Keep it a marker so the POI branch still renders.
vi.mock("@/components/planner/PoiDetails", () => ({
  PoiDetails: () => <div data-testid="poi-details" />,
}));

function renderPopover(point: MapPoint, extra?: Record<string, unknown>) {
  const onClose = vi.fn();
  render(
    <MapPointPopover
      point={point}
      x={10}
      y={20}
      onClose={onClose}
      {...extra}
    />,
  );
  return { onClose };
}

const poi: Poi = {
  id: "p1",
  category: "fuel",
  source: "osm",
  name: "Shell Station",
  lat: 49,
  lng: 14,
  meta: { mapsUrl: "https://maps.google.com/?q=x" },
};

describe("MapPointPopover", () => {
  it("close button fires onClose for any kind", () => {
    const { onClose } = renderPopover({ kind: "poi", poi });
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  describe("poi", () => {
    it("shows name, OSM attribution, and the Google Maps link (info-only)", () => {
      renderPopover({ kind: "poi", poi });
      expect(screen.getByText("Shell Station")).toBeInTheDocument();
      expect(
        screen.getByText(/OpenStreetMap contributors/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: /google maps/i }),
      ).toBeInTheDocument();
      // No route actions without an actions prop.
      expect(screen.queryByRole("button", { name: /add as via/i })).toBeNull();
    });

    it("renders route actions when provided (editable)", () => {
      const onAddVia = vi.fn();
      renderPopover(
        { kind: "poi", poi },
        {
          actions: {
            poi: { onAddVia, onSetStart: vi.fn(), onSetFinish: vi.fn() },
          },
        },
      );
      fireEvent.click(screen.getByRole("button", { name: /add as via/i }));
      expect(onAddVia).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("button", { name: /set as start/i }),
      ).toBeInTheDocument();
    });
  });

  describe("place (basemap OSM POI)", () => {
    const place = {
      name: "Brněnská oblast",
      category: "Information",
      lat: 49.2,
      lng: 16.6,
      mapsUrl: "https://www.google.com/maps/search/?api=1&query=x",
    };

    it("shows name, category, OSM credit and the Google Maps link (info-only)", () => {
      renderPopover({ kind: "place", place });
      expect(screen.getByText("Brněnská oblast")).toBeInTheDocument();
      expect(screen.getByText("Information")).toBeInTheDocument();
      expect(
        screen.getByText(/OpenStreetMap contributors/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: /google maps/i }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /add as via/i })).toBeNull();
    });

    it("titles an unnamed place by its category (no duplicate subtitle)", () => {
      renderPopover({
        kind: "place",
        place: {
          name: "",
          category: "Parking",
          lat: 49.2,
          lng: 16.6,
          mapsUrl: "https://www.google.com/maps/search/?api=1&query=x",
        },
      });
      // "Parking" appears exactly once (as the title, not also a subtitle).
      expect(screen.getAllByText("Parking")).toHaveLength(1);
      expect(
        screen.getByRole("link", { name: /google maps/i }),
      ).toBeInTheDocument();
    });

    it("renders placement actions when provided (editable planner)", () => {
      const onSetStart = vi.fn();
      renderPopover(
        { kind: "place", place },
        {
          actions: {
            poi: { onAddVia: vi.fn(), onSetStart, onSetFinish: vi.fn() },
          },
        },
      );
      expect(
        screen.getByRole("button", { name: /add as via/i }),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /set as start/i }));
      expect(onSetStart).toHaveBeenCalledOnce();
    });
  });

  describe("hazard", () => {
    it("shows the hazard label, severity, note and confirmations — no actions", () => {
      renderPopover({
        kind: "hazard",
        hazard: {
          hazard_type: "pothole",
          severity: "high",
          note: "Deep on the apex",
          reporter: "Ada",
          created_at: "2026-05-01T10:00:00.000Z",
          confirmations: 4,
        },
      });
      expect(screen.getByText(/deep on the apex/i)).toBeInTheDocument();
      expect(screen.getByText("High")).toBeInTheDocument();
      expect(screen.getByText(/✓ 4/)).toBeInTheDocument();
      // Hazards never carry a maps link or route actions.
      expect(screen.queryByRole("link", { name: /google maps/i })).toBeNull();
    });
  });

  describe("closure / pass", () => {
    const closure = {
      id: "c1",
      title: "Bridge closed",
      reason: "roadworks",
      severity: "full",
      notes: "Until spring",
      starts_at: "2026-05-01T00:00:00.000Z",
      ends_at: "2026-05-10T00:00:00.000Z",
    } as unknown as PlannerClosure;

    it("shows the reroute button only when it affects the route AND onReroute is given", () => {
      const onReroute = vi.fn();
      // affects route + onReroute → button present
      renderPopover(
        { kind: "closure", closure, affectsRoute: true },
        { actions: { onReroute } },
      );
      expect(screen.getByText(/affects your route/i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /reroute/i }));
      expect(onReroute).toHaveBeenCalledOnce();
    });

    it("no reroute button when the condition does not affect the route", () => {
      renderPopover(
        { kind: "closure", closure, affectsRoute: false },
        { actions: { onReroute: vi.fn() } },
      );
      expect(screen.queryByRole("button", { name: /reroute/i })).toBeNull();
      expect(screen.queryByText(/affects your route/i)).toBeNull();
    });

    it("renders a pass with elevation + region", () => {
      const pass = {
        id: "pass1",
        name: "Stelvio",
        status: "closed",
        elevation_m: 2757,
        region: "Alps",
      } as unknown as MountainPass;
      renderPopover({ kind: "pass", pass, affectsRoute: false });
      expect(screen.getByText("Stelvio")).toBeInTheDocument();
      expect(screen.getByText(/2,757 m · Alps/)).toBeInTheDocument();
    });
  });
});
