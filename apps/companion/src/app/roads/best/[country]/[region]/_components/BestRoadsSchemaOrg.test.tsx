import { render } from "@testing-library/react";
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
});
