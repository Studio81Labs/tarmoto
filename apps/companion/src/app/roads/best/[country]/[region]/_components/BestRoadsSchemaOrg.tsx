interface Road {
  id: string;
  road_name: string | null;
  road_number: string | null;
  quality_score: number | null;
  curviness_score: number;
  length_m: number;
}

interface Props {
  regionName: string;
  countryName: string;
  countryCode: string;
  regionSlug: string;
  parentSlug?: string;
  parentName?: string;
  pageUrl: string;
  description: string;
  roads: Road[];
}

// Serialises a JSON-LD payload for inline injection. Replaces `<` with
// `\u003c` so a pathological road name containing `</script>` can't
// terminate the surrounding script block.
function serializeLd(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

export function BestRoadsSchemaOrg({
  regionName,
  countryName,
  countryCode,
  regionSlug,
  parentSlug,
  parentName,
  pageUrl,
  description,
  roads,
}: Props) {
  const origin = pageUrl.replace(/\/roads\/best.*$/, "");

  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Best motorcycle roads in ${regionName}`,
    description,
    numberOfItems: roads.length,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    itemListElement: roads.map((r, i) => {
      const name =
        r.road_name ??
        (r.road_number
          ? `Road ${r.road_number}`
          : `Segment ${r.id.slice(0, 6)}`);
      const km = (r.length_m / 1000).toFixed(1);
      const quality = r.quality_score?.toFixed(1) ?? "unrated";
      return {
        "@type": "ListItem",
        position: i + 1,
        item: {
          "@type": "TouristAttraction",
          name,
          description: `Quality ${quality} \u00b7 Curviness ${r.curviness_score.toFixed(1)} \u00b7 ${km} km`,
          touristType: "Motorcyclist",
        },
      };
    }),
  };

  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: parentSlug
      ? [
          {
            "@type": "ListItem",
            position: 1,
            name: "Best roads",
            item: `${origin}/roads/best`,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: countryName,
            item: `${origin}/roads/best/${countryCode}`,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: parentName ?? parentSlug,
            item: `${origin}/roads/best/${countryCode}/${parentSlug}`,
          },
          {
            "@type": "ListItem",
            position: 4,
            name: regionName,
            item: `${origin}/roads/best/${countryCode}/${parentSlug}/${regionSlug}`,
          },
        ]
      : [
          {
            "@type": "ListItem",
            position: 1,
            name: "Best roads",
            item: `${origin}/roads/best`,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: countryName,
            item: `${origin}/roads/best/${countryCode}`,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: regionName,
            item: `${origin}/roads/best/${countryCode}/${regionSlug}`,
          },
        ],
  };

  const itemListJson = serializeLd(itemList);
  const breadcrumbsJson = serializeLd(breadcrumbs);

  return (
    <>
      <ScriptTag json={itemListJson} />
      <ScriptTag json={breadcrumbsJson} />
    </>
  );
}

function ScriptTag({ json }: { json: string }) {
  // JSON-LD for search crawlers must live in the initial HTML as an inline
  // script. Content is derived entirely from catalog + backend response (no
  // user input today) and `serializeLd` escapes `<` so it cannot break out
  // of the script tag.
  const html = { __html: json };
  return <script type="application/ld+json" dangerouslySetInnerHTML={html} />;
}
