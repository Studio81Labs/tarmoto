import type { BestRoad } from "@/lib/bestRoads";
import type { Formatters, SupportedLocale } from "@tarmoto/shared";
import { publicLocalePath, type Translate } from "@/i18n";
type Road = Pick<
  BestRoad,
  "id" | "road_name" | "road_number" | "curviness_score" | "length_m"
> & {
  /** Absent when `road_quality_overlay` is killed — see BestRoadsPageBody.
   *  Distinct from `null`, which means the road genuinely has no score yet
   *  and still renders as "unrated". */
  quality_score?: number | null;
};

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
  locale: SupportedLocale;
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
  locale,
}: Props) {
  const origin = pageUrl.replace(/\/roads\/best.*$/, "");
  const publicUrl = (pathname: string) =>
    `${origin}${publicLocalePath(pathname, locale)}`;

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
      // A stripped score (key ABSENT) drops the quality clause from the
      // description outright — a "unrated" placeholder in structured data
      // would be a false statement about the road AND would still tell a
      // crawler the dimension exists. A `null` score is different: the road
      // really has no rating yet, which "unrated" describes correctly.
      const curviness = format.decimal(r.curviness_score, 1);
      const distance = format.distanceKm(r.length_m / 1000);
      const description =
        r.quality_score === undefined
          ? t("Curviness {curviness} · {distance}", { curviness, distance })
          : t("Quality {quality} · Curviness {curviness} · {distance}", {
              quality:
                r.quality_score === null
                  ? t("unrated")
                  : format.decimal(r.quality_score, 1),
              curviness,
              distance,
            });
      return {
        "@type": "ListItem",
        position: i + 1,
        item: {
          "@type": "TouristAttraction",
          name,
          description,
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
            item: publicUrl("/roads/best"),
          },
          {
            "@type": "ListItem",
            position: 2,
            name: countryName,
            item: publicUrl(`/roads/best/${countryCode}`),
          },
          {
            "@type": "ListItem",
            position: 3,
            name: parentName ?? parentSlug,
            item: publicUrl(`/roads/best/${countryCode}/${parentSlug}`),
          },
          {
            "@type": "ListItem",
            position: 4,
            name: regionName,
            item: publicUrl(
              `/roads/best/${countryCode}/${parentSlug}/${regionSlug}`,
            ),
          },
        ]
      : [
          {
            "@type": "ListItem",
            position: 1,
            name: t("Best roads"),
            item: publicUrl("/roads/best"),
          },
          {
            "@type": "ListItem",
            position: 2,
            name: countryName,
            item: publicUrl(`/roads/best/${countryCode}`),
          },
          {
            "@type": "ListItem",
            position: 3,
            name: regionName,
            item: publicUrl(`/roads/best/${countryCode}/${regionSlug}`),
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
