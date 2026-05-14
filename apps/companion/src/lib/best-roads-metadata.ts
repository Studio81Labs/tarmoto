import type { Metadata } from "next";

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
}

export function normalizeCountryParam(country: string): string {
  return country.toLowerCase();
}

export function normalizeSlugParam(slug: string): string {
  return slug.toLowerCase();
}

export function buildBestRoadsMetadata({
  title,
  description,
  canonicalPath,
  imageAlt,
}: BestRoadsMetadataInput): Metadata {
  return {
    title,
    description,
    alternates: { canonical: canonicalPath },
    openGraph: {
      title,
      description,
      url: canonicalPath,
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
