import { render } from "@testing-library/react";
import { createFormatters } from "@tarmoto/shared";
import { t } from "@/i18n";
import { BestRoadsSchemaOrg } from "./BestRoadsSchemaOrg";

describe("BestRoadsSchemaOrg", () => {
  it("T70: renders valid ItemList and BreadcrumbList structured data", () => {
    const { container } = render(
      <BestRoadsSchemaOrg
        regionName="Tyrol"
        countryName="Austria"
        countryCode="at"
        regionSlug="tyrol"
        pageUrl="https://tarmoto.com/roads/best/at/tyrol"
        description="Alpine riding routes."
        format={createFormatters({ locale: "en", units: "metric" })}
        t={t}
        locale="en"
        roads={[
          {
            id: "road-123456",
            road_name: "Timmelsjoch",
            road_number: null,
            quality_score: 4.8,
            curviness_score: 93,
            length_m: 32100,
          },
        ]}
      />,
    );

    const payloads = Array.from(
      container.querySelectorAll('script[type="application/ld+json"]'),
    ).map((script) => JSON.parse(script.textContent ?? ""));

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      "@context": "https://schema.org",
      "@type": "ItemList",
      numberOfItems: 1,
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          item: {
            "@type": "TouristAttraction",
            name: "Timmelsjoch",
          },
        },
      ],
    });
    expect(payloads[1]).toMatchObject({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1 },
        { "@type": "ListItem", position: 2 },
        { "@type": "ListItem", position: 3, name: "Tyrol" },
      ],
    });
  });
  it("drops the quality clause from the JSON-LD when the score is STRIPPED", () => {
    // Key absent = the operator killed `road_quality_overlay`. A placeholder
    // in structured data would still advertise the dimension to a crawler,
    // which is the thing the kill exists to stop.
    const { container } = render(
      <BestRoadsSchemaOrg
        regionName="Tyrol"
        countryName="Austria"
        countryCode="at"
        regionSlug="tyrol"
        pageUrl="https://tarmoto.com/roads/best/at/tyrol"
        description="Alpine riding routes."
        format={createFormatters({ locale: "en", units: "metric" })}
        t={t}
        locale="en"
        roads={[
          {
            id: "road-123456",
            road_name: "Timmelsjoch",
            road_number: null,
            curviness_score: 93,
            length_m: 32100,
          },
        ]}
      />,
    );

    const ld = container.querySelector('script[type="application/ld+json"]');
    const raw = ld?.textContent ?? "";
    expect(raw).not.toContain("Quality");
    expect(raw).not.toContain("unrated");
    expect(raw).not.toContain("4.8");
    // Curviness and distance still describe the road.
    expect(JSON.parse(raw).itemListElement[0].item.description).toBe(
      "Curviness 93.0 · 32.1 km",
    );
  });

  it("still says 'unrated' for a road with a NULL score while the flag is live", () => {
    // A null score is a road with no rating yet — a real fact about the road,
    // and a different thing from an operator kill. Keeping the two apart is
    // why the strip removes the key instead of nulling it.
    const { container } = render(
      <BestRoadsSchemaOrg
        regionName="Tyrol"
        countryName="Austria"
        countryCode="at"
        regionSlug="tyrol"
        pageUrl="https://tarmoto.com/roads/best/at/tyrol"
        description="Alpine riding routes."
        format={createFormatters({ locale: "en", units: "metric" })}
        t={t}
        locale="en"
        roads={[
          {
            id: "road-123456",
            road_name: "Timmelsjoch",
            road_number: null,
            quality_score: null,
            curviness_score: 93,
            length_m: 32100,
          },
        ]}
      />,
    );

    const raw =
      container.querySelector('script[type="application/ld+json"]')
        ?.textContent ?? "";
    expect(JSON.parse(raw).itemListElement[0].item.description).toBe(
      "Quality unrated · Curviness 93.0 · 32.1 km",
    );
  });
});
