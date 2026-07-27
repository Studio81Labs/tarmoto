import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";
import {
  COUNTRIES,
  SUPPORTED_LOCALES,
  listIndexableRegions,
} from "@tarmoto/shared";
import { publicLocalePath } from "@/i18n";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const lastModified = new Date();

  const localizedEntry = (
    pathname: string,
    options: Omit<MetadataRoute.Sitemap[number], "url">,
  ): MetadataRoute.Sitemap =>
    SUPPORTED_LOCALES.map((locale) => ({
      url: `${base}${publicLocalePath(pathname, locale)}`,
      ...options,
    }));

  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified, changeFrequency: "weekly", priority: 1 },
    ...localizedEntry("/explore", {
      lastModified,
      changeFrequency: "daily",
      priority: 0.9,
    }),
    ...localizedEntry("/roads/best", {
      lastModified,
      changeFrequency: "weekly",
      priority: 0.85,
    }),
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

  const countryEntries: MetadataRoute.Sitemap = COUNTRIES.flatMap((c) =>
    localizedEntry(`/roads/best/${c.code}`, {
      lastModified,
      changeFrequency: "weekly",
      priority: 0.8,
    }),
  );

  const regionEntries: MetadataRoute.Sitemap = listIndexableRegions().flatMap(
    (r) =>
      localizedEntry(
        r.parent
          ? `/roads/best/${r.country}/${r.parent}/${r.slug}`
          : `/roads/best/${r.country}/${r.slug}`,
        {
          lastModified,
          changeFrequency: "weekly",
          priority: 0.8,
        },
      ),
  );

  return [...staticEntries, ...countryEntries, ...regionEntries];
}
