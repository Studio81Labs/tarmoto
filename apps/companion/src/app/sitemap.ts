import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";
import { COUNTRIES, listIndexableRegions } from "@tarmoto/shared";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const lastModified = new Date();

  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified, changeFrequency: "weekly", priority: 1 },
    {
      url: `${base}/explore`,
      lastModified,
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${base}/discover`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${base}/roads/best`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.85,
    },
    {
      url: `${base}/login`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${base}/register`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.4,
    },
  ];

  const countryEntries: MetadataRoute.Sitemap = COUNTRIES.map((c) => ({
    url: `${base}/roads/best/${c.code}`,
    lastModified,
    changeFrequency: "weekly" as const,
    priority: 0.8,
  }));

  const regionEntries: MetadataRoute.Sitemap = listIndexableRegions().map(
    (r) => ({
      url: r.parent
        ? `${base}/roads/best/${r.country}/${r.parent}/${r.slug}`
        : `${base}/roads/best/${r.country}/${r.slug}`,
      lastModified,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    }),
  );

  return [...staticEntries, ...countryEntries, ...regionEntries];
}
