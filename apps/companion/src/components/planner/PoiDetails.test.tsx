import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PoiDetails, hasPoiDetails, readPoiDetails } from "./PoiDetails";
import type { Poi } from "@/lib/planner/types";

function poi(meta?: Record<string, unknown>): Poi {
  return {
    id: "p1",
    category: "food",
    source: "osm",
    name: "Test POI",
    lat: 49,
    lng: 15,
    ...(meta === undefined ? {} : { meta }),
  };
}

describe("readPoiDetails", () => {
  it("extracts the present decision-support fields off meta", () => {
    expect(
      readPoiDetails(
        poi({
          stars: 4,
          openingHours: "Mo-Fr 09:00-18:00",
          addressStreet: "Main 1",
          addressCity: "Brno",
          phone: "+420 111",
          website: "https://ulesa.example/",
          cuisine: "italian",
          brand: "Shell",
          // Unrelated keys the store never sets — must be ignored:
          mapsUrl: "https://maps.example/x",
          osmUrl: "https://osm.example/x",
        }),
      ),
    ).toEqual({
      stars: 4,
      openingHours: "Mo-Fr 09:00-18:00",
      addressStreet: "Main 1",
      addressCity: "Brno",
      phone: "+420 111",
      website: "https://ulesa.example/",
      cuisine: "italian",
      brand: "Shell",
    });
  });

  it("drops null, blank, and wrong-typed values", () => {
    const d = readPoiDetails(
      poi({
        stars: "4", // wrong type → dropped
        openingHours: null,
        addressCity: "   ", // blank → dropped
        website: "",
        cuisine: 123, // wrong type → dropped
      }),
    );
    expect(hasPoiDetails(d)).toBe(false);
  });

  it("ignores mock-only meta keys (twisty score, elevation, status)", () => {
    const d = readPoiDetails(
      poi({ twistyScore: 8, elevationM: 900, status: "open" }),
    );
    expect(hasPoiDetails(d)).toBe(false);
  });

  it("treats an absent meta bag as no details", () => {
    expect(hasPoiDetails(readPoiDetails(poi(undefined)))).toBe(false);
  });

  it("assumes https for a scheme-less website and keeps http(s) ones", () => {
    expect(readPoiDetails(poi({ website: "www.cafe.example" })).website).toBe(
      "https://www.cafe.example/",
    );
    expect(readPoiDetails(poi({ website: "http://x.example/a" })).website).toBe(
      "http://x.example/a",
    );
  });

  it("drops a website with a non-http scheme", () => {
    expect(
      readPoiDetails(poi({ website: "javascript:alert(1)" })).website,
    ).toBeUndefined();
    expect(
      hasPoiDetails(readPoiDetails(poi({ website: "mailto:a@b.example" }))),
    ).toBe(false);
  });
});

describe("PoiDetails", () => {
  it("renders nothing when the POI carries no decision-support fields", () => {
    const { container } = render(<PoiDetails poi={poi({ twistyScore: 8 })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the present fields with tel + website links", () => {
    render(
      <PoiDetails
        poi={poi({
          stars: 3,
          cuisine: "pizza",
          openingHours: "24/7",
          addressStreet: "Hlavní 5",
          addressCity: "Ostrava",
          phone: "+420 571 111 111",
          website: "https://www.penzion.cz/",
        })}
      />,
    );
    expect(screen.getByText("3-star")).toBeInTheDocument();
    expect(screen.getByText("pizza")).toBeInTheDocument();
    expect(screen.getByText("24/7")).toBeInTheDocument();
    expect(screen.getByText("Hlavní 5, Ostrava")).toBeInTheDocument();

    const tel = screen.getByRole("link", { name: /\+420 571 111 111/ });
    // Whitespace is stripped from the dialable href but kept in the label.
    expect(tel).toHaveAttribute("href", "tel:+420571111111");

    const web = screen.getByRole("link", { name: /penzion\.cz/ });
    expect(web).toHaveAttribute("href", "https://www.penzion.cz/");
    // Protocol + www. + trailing slash are stripped from the visible label.
    expect(web).toHaveTextContent("penzion.cz");
  });

  it("shows cuisine over brand, and falls back to brand alone", () => {
    const { rerender } = render(
      <PoiDetails poi={poi({ cuisine: "sushi", brand: "Nordsee" })} />,
    );
    expect(screen.getByText("sushi")).toBeInTheDocument();
    expect(screen.queryByText("Nordsee")).not.toBeInTheDocument();

    rerender(<PoiDetails poi={poi({ brand: "Shell" })} />);
    expect(screen.getByText("Shell")).toBeInTheDocument();
  });

  it("joins street and city, and shows city alone when no street", () => {
    const { rerender } = render(
      <PoiDetails poi={poi({ addressCity: "Ostrava" })} />,
    );
    expect(screen.getByText("Ostrava")).toBeInTheDocument();

    rerender(<PoiDetails poi={poi({ addressStreet: "Hlavní 5" })} />);
    expect(screen.getByText("Hlavní 5")).toBeInTheDocument();
  });
});
