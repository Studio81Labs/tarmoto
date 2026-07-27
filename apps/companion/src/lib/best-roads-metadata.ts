import type { Metadata } from "next";
import {
  publicLanguageAlternates,
  publicLocalePath,
  type SupportedLocale,
} from "@/i18n";

const OG_IMAGE_SIZE = {
  width: 1200,
  height: 630,
};
const BEST_ROADS_OG_IMAGE = "/og/best-roads.svg";

interface BestRoadsMetadataInput {
  title: string;
  description: string;
  canonicalPath: string;
  imageAlt: string;
  locale: SupportedLocale;
}

export function normalizeCountryParam(country: string): string {
  // Country route parameters are canonical ASCII identifiers.
  // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search
  return country.toLowerCase();
}

export function normalizeSlugParam(slug: string): string {
  // Metadata slugs are canonical URL tokens.
  // eslint-disable-next-line tarmoto-localization/no-locale-insensitive-search
  return slug.toLowerCase();
}

export function buildBestRoadsMetadata({
  title,
  description,
  canonicalPath,
  imageAlt,
  locale,
}: BestRoadsMetadataInput): Metadata {
  const localizedCanonical = publicLocalePath(canonicalPath, locale);
  return {
    title,
    description,
    alternates: {
      canonical: localizedCanonical,
      languages: publicLanguageAlternates(canonicalPath),
    },
    openGraph: {
      title,
      description,
      url: localizedCanonical,
      type: "website",
      images: [
        {
          url: BEST_ROADS_OG_IMAGE,
          width: OG_IMAGE_SIZE.width,
          height: OG_IMAGE_SIZE.height,
          alt: imageAlt,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [BEST_ROADS_OG_IMAGE],
    },
  };
}
