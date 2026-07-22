import type { BestRoad } from "@/lib/bestRoads";
import type { Formatters } from "@tarmoto/shared";
import type { Translate } from "@/i18n";
type Road = Pick<
  BestRoad,
  | "id"
  | "road_name"
  | "road_number"
  | "quality_score"
  | "curviness_score"
  | "length_m"
>;

interface Props {
  regionName: string;
  countryName: string;
  countryCode: string;
  regionSlug: string;
  parentSlug?: string | undefined;
  parentName?: string | undefined;
  pageUrl: string;
  description: string;
  roads: Road[];
  format: Formatters;
  t: Translate;
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
  format,
  t,
}: Props) {
  const origin = pageUrl.replace(/\/roads\/best.*$/, "");

  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: t("Best motorcycle roads in {name}", { name: regionName }),
    description,
    numberOfItems: roads.length,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    itemListElement: roads.map((r, i) => {
      const name =
        r.road_name ??
        (r.road_number
          ? t("Road {number}", { number: r.road_number })
          : t("Segment {id}", { id: r.id.slice(0, 6) }));
      const quality =
        r.quality_score === null || r.quality_score === undefined
          ? t("unrated")
          : format.decimal(r.quality_score, 1);
      return {
        "@type": "ListItem",
        position: i + 1,
        item: {
          "@type": "TouristAttraction",
          name,
          description: t(
            "Quality {quality} · Curviness {curviness} · {distance}",
            {
              quality,
              curviness: format.decimal(r.curviness_score, 1),
              distance: format.distanceKm(r.length_m / 1000),
            },
          ),
          touristType: t("Motorcyclist"),
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
            name: t("Best roads"),
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
            name: t("Best roads"),
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
