export const regions = {
  "Czech Republic": "Czech Republic",
  Austria: "Austria",
  Italy: "Italy",
  Beskydy: "Beskydy",
  Jeseníky: "Jeseníky",
  Šumava: "Šumava",
  Tyrol: "Tyrol",
  "Alpine Passes": "Alpine Passes",
  Dolomites: "Dolomites",
  "The Moravian-Silesian Beskydy range climbs from the Ostrava basin into rolling forested ridgelines. Narrow ridge roads, long sweeping descents, and the iconic climb to Lysá hora make it a favourite weekend loop.":
    "The Moravian-Silesian Beskydy range climbs from the Ostrava basin into rolling forested ridgelines. Narrow ridge roads, long sweeping descents, and the iconic climb to Lysá hora make it a favourite weekend loop.",
  "Higher and colder than the Beskydy, the Jeseníky mountains offer open highland roads over Červenohorské sedlo and the long sweeping arcs around Praděd — the tallest peak in Moravia.":
    "Higher and colder than the Beskydy, the Jeseníky mountains offer open highland roads over Červenohorské sedlo and the long sweeping arcs around Praděd — the tallest peak in Moravia.",
  "Long, quiet forest roads trace the Czech-Bavarian border through the Šumava national park. Lower elevation than the Alps but rewarding for pure riding flow over long distances.":
    "Long, quiet forest roads trace the Czech-Bavarian border through the Šumava national park. Lower elevation than the Alps but rewarding for pure riding flow over long distances.",
  "The heart of the Austrian Alps. Hairpin-stitched passes, glacier-fed valleys and the highest paved road in Austria — Tyrol packs more legendary motorcycle roads into one province than most countries.":
    "The heart of the Austrian Alps. Hairpin-stitched passes, glacier-fed valleys and the highest paved road in Austria — Tyrol packs more legendary motorcycle roads into one province than most countries.",
  "The signature high passes of Tyrol — Timmelsjoch, Hahntennjoch, Silvretta-Hochalpenstraße — collected onto a single route list.":
    "The signature high passes of Tyrol — Timmelsjoch, Hahntennjoch, Silvretta-Hochalpenstraße — collected onto a single route list.",
  "Jagged limestone spires frame a web of hairpin roads — Passo Pordoi, Passo Sella, Passo Giau — each a riding pilgrimage in its own right.":
    "Jagged limestone spires frame a web of hairpin roads — Passo Pordoi, Passo Sella, Passo Giau — each a riding pilgrimage in its own right.",
  "{start} – {end}": "{start} – {end}",
  "Road {number}": "Road {number}",
  "Segment {id}": "Segment {id}",
  "Quality {quality} · Curviness {curviness} · {distance}":
    "Quality {quality} · Curviness {curviness} · {distance}",
  // Same line with the quality clause dropped, for when the operator has
  // killed `road_quality_overlay`. A placeholder value would leave the
  // dimension visible to a crawler, which is what the kill is for.
  "Curviness {curviness} · {distance}": "Curviness {curviness} · {distance}",
  unrated: "unrated",
  Motorcyclist: "Motorcyclist",
  "{count, plural, one {# curated region — tap through for ranked roads, quality scores and a map preview.} other {# curated regions — tap through for ranked roads, quality scores and a map preview.}}":
    "{count, plural, one {# curated region — tap through for ranked roads, quality scores and a map preview.} other {# curated regions — tap through for ranked roads, quality scores and a map preview.}}",
} as const;
