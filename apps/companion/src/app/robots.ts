import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: [
          "/",
          "/explore",
          "/discover",
          "/roads/best",
          "/login",
          "/register",
        ],
        disallow: [
          "/api/",
          "/forgot-password",
          "/rides",
          "/trips",
          "/community",
          "/gamification",
          "/settings",
        ],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
