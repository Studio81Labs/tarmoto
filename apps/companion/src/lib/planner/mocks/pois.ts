import type { Poi, PoiCategory } from "../types";

/**
 * Category-POI fixtures (revision 4 §B) — a realistic CZ spread with a
 * dense Beskydy cluster, covering every category and all three sources.
 * Real target: OSM/Overpass for the amenity categories, the seasonal
 * pass source for mountain_pass, and Tarmoto's curviness + quality
 * layer for twisty_highlight. Swap in `plannerApi.getPoisByCategories`.
 */
const POI_FIXTURES: Poi[] = [
  // ── Beskydy cluster ──────────────────────────────────────────────
  {
    id: "fuel-beskydy-1",
    category: "fuel",
    source: "osm",
    name: "Benzina Frenštát",
    lat: 49.5483,
    lng: 18.2108,
  },
  {
    id: "fuel-beskydy-2",
    category: "fuel",
    source: "osm",
    name: "Orlen Rožnov",
    lat: 49.4586,
    lng: 18.143,
  },
  {
    id: "fuel-beskydy-3",
    category: "fuel",
    source: "osm",
    name: "EuroOil Jablunkov",
    lat: 49.5766,
    lng: 18.7646,
  },
  {
    id: "food-beskydy-1",
    category: "food",
    source: "osm",
    name: "Koliba Pustevny",
    lat: 49.4907,
    lng: 18.2652,
  },
  {
    id: "food-beskydy-2",
    category: "food",
    source: "osm",
    name: "Restaurace Ondrášův dvůr",
    lat: 49.5443,
    lng: 18.4291,
  },
  {
    id: "cafe-beskydy-1",
    category: "cafe",
    source: "osm",
    name: "Kavárna Rožnov",
    lat: 49.4602,
    lng: 18.1481,
  },
  {
    id: "cafe-beskydy-2",
    category: "cafe",
    source: "osm",
    name: "Café Bezručova chata",
    lat: 49.5407,
    lng: 18.4482,
  },
  {
    id: "view-beskydy-1",
    category: "viewpoint",
    source: "osm",
    name: "Lysá hora vyhlídka",
    lat: 49.5461,
    lng: 18.4475,
  },
  {
    id: "view-beskydy-2",
    category: "viewpoint",
    source: "osm",
    name: "Radhošť",
    lat: 49.4911,
    lng: 18.2244,
  },
  {
    id: "camp-beskydy-1",
    category: "campground",
    source: "osm",
    name: "Kemp Frenštát",
    lat: 49.5372,
    lng: 18.2033,
  },
  {
    id: "hotel-beskydy-1",
    category: "biker_hotel",
    source: "osm",
    name: "Motorest Zavadilka",
    lat: 49.5024,
    lng: 18.3654,
    meta: { bikerFriendly: true },
  },
  {
    id: "hotel-beskydy-2",
    category: "biker_hotel",
    source: "osm",
    name: "Hotel Ráztoka",
    lat: 49.5199,
    lng: 18.2451,
    meta: { bikerFriendly: true },
  },
  {
    id: "pass-beskydy-1",
    category: "mountain_pass",
    source: "passes",
    name: "Pustevny sedlo",
    lat: 49.4888,
    lng: 18.2631,
    meta: { status: "open", elevationM: 1018 },
  },
  {
    id: "pass-beskydy-2",
    category: "mountain_pass",
    source: "passes",
    name: "Bumbálka",
    lat: 49.4187,
    lng: 18.3789,
    meta: { status: "open", elevationM: 870 },
  },
  {
    id: "twisty-beskydy-1",
    category: "twisty_highlight",
    source: "tarmoto",
    name: "SS-bends",
    lat: 49.4939,
    lng: 18.2887,
    meta: { twistyScore: 92, lengthKm: 4.1 },
  },
  {
    id: "twisty-beskydy-2",
    category: "twisty_highlight",
    source: "tarmoto",
    name: "Soláň ridge run",
    lat: 49.4116,
    lng: 18.2489,
    meta: { twistyScore: 87, lengthKm: 7.8 },
  },

  // ── Vysočina / Devět skal ────────────────────────────────────────
  {
    id: "view-vysocina-1",
    category: "viewpoint",
    source: "osm",
    name: "Devět skal vista",
    lat: 49.6395,
    lng: 16.0369,
  },
  {
    id: "cafe-vysocina-1",
    category: "cafe",
    source: "osm",
    name: "Kavárna Nové Město",
    lat: 49.5613,
    lng: 16.0741,
  },
  {
    id: "fuel-vysocina-1",
    category: "fuel",
    source: "osm",
    name: "MOL Žďár nad Sázavou",
    lat: 49.5643,
    lng: 15.9392,
  },
  {
    id: "twisty-vysocina-1",
    category: "twisty_highlight",
    source: "tarmoto",
    name: "Svratka esses",
    lat: 49.7089,
    lng: 16.0322,
    meta: { twistyScore: 78, lengthKm: 5.6 },
  },

  // ── Prague corridor ──────────────────────────────────────────────
  {
    id: "fuel-praha-1",
    category: "fuel",
    source: "osm",
    name: "Shell Praha-Chodov",
    lat: 50.0303,
    lng: 14.4906,
  },
  {
    id: "food-praha-1",
    category: "food",
    source: "osm",
    name: "Motorkářská hospoda U Vinců",
    lat: 49.9884,
    lng: 14.6592,
  },
  {
    id: "cafe-praha-1",
    category: "cafe",
    source: "osm",
    name: "Café Sázava",
    lat: 49.8716,
    lng: 14.8964,
  },
  {
    id: "hotel-praha-1",
    category: "biker_hotel",
    source: "osm",
    name: "Penzion U Řeky",
    lat: 49.8811,
    lng: 14.9017,
    meta: { bikerFriendly: true },
  },

  // ── Šumava ───────────────────────────────────────────────────────
  {
    id: "view-sumava-1",
    category: "viewpoint",
    source: "osm",
    name: "Poledník rozhledna",
    lat: 49.0637,
    lng: 13.395,
  },
  {
    id: "camp-sumava-1",
    category: "campground",
    source: "osm",
    name: "Kemp Lipno",
    lat: 48.6394,
    lng: 14.2314,
  },
  {
    id: "fuel-sumava-1",
    category: "fuel",
    source: "osm",
    name: "Benzina Vimperk",
    lat: 49.0498,
    lng: 13.7768,
  },
  {
    id: "twisty-sumava-1",
    category: "twisty_highlight",
    source: "tarmoto",
    name: "Lipno shore sweepers",
    lat: 48.6641,
    lng: 14.1005,
    meta: { twistyScore: 81, lengthKm: 9.4 },
  },

  // ── Krkonoše / Jeseníky passes ───────────────────────────────────
  {
    id: "pass-krkonose-1",
    category: "mountain_pass",
    source: "passes",
    name: "Špindlerův Můstek",
    lat: 50.7377,
    lng: 15.6091,
    meta: { status: "seasonal", elevationM: 1198 },
  },
  {
    id: "pass-jeseniky-1",
    category: "mountain_pass",
    source: "passes",
    name: "Červenohorské sedlo",
    lat: 50.1231,
    lng: 17.1553,
    meta: { status: "open", elevationM: 1013 },
  },
  {
    id: "view-jeseniky-1",
    category: "viewpoint",
    source: "osm",
    name: "Praděd",
    lat: 50.0831,
    lng: 17.2314,
  },
  {
    id: "camp-krkonose-1",
    category: "campground",
    source: "osm",
    name: "Autokemp Vrchlabí",
    lat: 50.6339,
    lng: 15.6197,
  },
  {
    id: "hotel-jeseniky-1",
    category: "biker_hotel",
    source: "osm",
    name: "Chata Barborka",
    lat: 50.0721,
    lng: 17.2278,
    meta: { bikerFriendly: true },
  },
  {
    id: "food-krkonose-1",
    category: "food",
    source: "osm",
    name: "Bouda Máma",
    lat: 50.6912,
    lng: 15.7229,
  },

  // ── South Moravia ────────────────────────────────────────────────
  {
    id: "fuel-brno-1",
    category: "fuel",
    source: "osm",
    name: "OMV Brno-Bystrc",
    lat: 49.2262,
    lng: 16.5217,
  },
  {
    id: "cafe-brno-1",
    category: "cafe",
    source: "osm",
    name: "Café Pálava",
    lat: 48.8489,
    lng: 16.6446,
  },
  {
    id: "view-brno-1",
    category: "viewpoint",
    source: "osm",
    name: "Děvičky vista",
    lat: 48.8672,
    lng: 16.6373,
  },
  {
    id: "twisty-brno-1",
    category: "twisty_highlight",
    source: "tarmoto",
    name: "Vranov dam twisties",
    lat: 48.9061,
    lng: 15.8172,
    meta: { twistyScore: 84, lengthKm: 6.2 },
  },
];

/**
 * Bbox + category filter over the fixtures — the mock shape of the real
 * mixed-source resolver. `bbox` is [west, south, east, north].
 */
export function mockPoisByCategories(
  bbox: [number, number, number, number],
  categories: readonly PoiCategory[],
): Poi[] {
  if (categories.length === 0) return [];
  const [west, south, east, north] = bbox;
  const wanted = new Set(categories);
  return POI_FIXTURES.filter(
    (poi) =>
      wanted.has(poi.category) &&
      poi.lng >= west &&
      poi.lng <= east &&
      poi.lat >= south &&
      poi.lat <= north,
  );
}
