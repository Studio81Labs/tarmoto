import { render, screen } from "@testing-library/react";
import { FormatProvider } from "@/format/FormatProvider";
import { I18nProvider } from "@/i18n/I18nProvider";
import { t } from "@/i18n";
import type { TripDay } from "@/lib/types";
import { DayByDayList, dayRouteLabel } from "./DayByDayList";

// Kill switches fail SAFE (enabled until a confirmed `force_off`); the real
// hook needs a QueryClientProvider this suite does not set up.
const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/hooks/useEntitlements", () => ({
  useFeatureKillSwitch: () => ({
    enabled: killSwitch.enabled,
    isResolved: true,
  }),
}));

describe("DayByDayList", () => {
  it("renders an unnamed overnight POI from its semantic category", () => {
    const day: TripDay = {
      dayNumber: 1,
      title: "Day 1",
      waypoints: [],
      distanceKm: 120,
      durationMinutes: 150,
      elevationGain: 900,
      avgQuality: 4,
      overnightStop: {
        id: "camp-1",
        name: "",
        type: "accommodation",
        poiCategory: "campground",
        location: { lng: 10.5, lat: 46.5 },
      },
    };

    render(
      <I18nProvider locale="en">
        <FormatProvider formatLocale="en" timeZone="UTC" units="metric">
          <DayByDayList
            days={[day]}
            selectedDayNumber={null}
            onSelectDay={vi.fn()}
          />
        </FormatProvider>
      </I18nProvider>,
    );

    expect(screen.getByText("Overnight: Campground")).toBeInTheDocument();
  });

  it("preserves source-owned route and overnight labels matching legacy roles", () => {
    const day: TripDay = {
      dayNumber: 1,
      title: "Day 1",
      waypoints: [
        {
          id: "start",
          name: "Start",
          nameIsSource: true,
          type: "start",
          location: { lng: 10.1, lat: 46.1 },
        },
        {
          id: "end",
          name: "End",
          nameIsSource: true,
          type: "end",
          location: { lng: 10.2, lat: 46.2 },
        },
      ],
      distanceKm: 120,
      durationMinutes: 150,
      elevationGain: 900,
      avgQuality: 4,
      overnightStop: {
        id: "stay",
        name: "Via 1",
        nameIsSource: true,
        type: "accommodation",
        location: { lng: 10.2, lat: 46.2 },
      },
    };

    expect(dayRouteLabel(day, t)).toBe("Start → End");

    render(
      <I18nProvider locale="en">
        <FormatProvider formatLocale="en" timeZone="UTC" units="metric">
          <DayByDayList
            days={[day]}
            selectedDayNumber={null}
            onSelectDay={vi.fn()}
          />
        </FormatProvider>
      </I18nProvider>,
    );

    expect(screen.getByText("Overnight: Via 1")).toBeInTheDocument();
  });

  function multiDay() {
    return [1, 2, 3].map((dayNumber) => ({
      dayNumber,
      title: `Day ${dayNumber}`,
      waypoints: [],
      distanceKm: 100,
      durationMinutes: 120,
      elevationGain: 500,
      avgQuality: 4,
    })) as unknown as Parameters<typeof DayByDayList>[0]["days"];
  }

  function renderDays() {
    return render(
      <I18nProvider locale="en">
        <FormatProvider formatLocale="en" timeZone="UTC" units="metric">
          <DayByDayList
            days={multiDay()}
            selectedDayNumber={null}
            onSelectDay={vi.fn()}
          />
        </FormatProvider>
      </I18nProvider>,
    );
  }

  it("shows a quality glyph per day normally", () => {
    renderDays();
    expect(screen.getAllByRole("img")).toHaveLength(3);
  });

  it("drops every day's quality glyph when the overlay is killed", () => {
    // Shared by the saved-trip view and the planner, so gating here covers both
    // callers. Multi-day on purpose: a per-row gate that missed one row would
    // pass a single-day test.
    killSwitch.enabled = false;
    renderDays();
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    // The rest of each day survives — distance and duration are not quality.
    expect(screen.getByText("Day 1")).toBeInTheDocument();
    expect(screen.getByText("Day 3")).toBeInTheDocument();
  });
});
