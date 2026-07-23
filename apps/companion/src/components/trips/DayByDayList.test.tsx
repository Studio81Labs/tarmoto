import { render, screen } from "@testing-library/react";
import { FormatProvider } from "@/format/FormatProvider";
import { I18nProvider } from "@/i18n/I18nProvider";
import type { TripDay } from "@/lib/types";
import { DayByDayList, dayRouteLabel } from "./DayByDayList";

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

    expect(dayRouteLabel(day)).toBe("Start → End");

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
});
