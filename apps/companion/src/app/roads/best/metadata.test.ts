import { generateMetadata as generateCountryMetadata } from "./[country]/page";
import { generateMetadata as generateRegionMetadata } from "./[country]/[region]/page";
import { generateMetadata as generateSubregionMetadata } from "./[country]/[region]/[subregion]/page";

// The 3 static layouts (root, explore, roads/best) were converted to
// `generateMetadata` in this task (PR 2 task 6). Importing their modules
// drags in dependencies that aren't resolvable outside a real Next.js build:
// `next/font/local` has no callable runtime export under Vite/Vitest, and
// `@/lib/auth` (next-auth) fails to resolve `next/server` in this pnpm/test
// setup. Neither is exercised by `generateMetadata` itself (fonts render in
// the component body; `auth()` is only called in the layout components), so
// stubbing both is safe and hermetic.
vi.mock("next/font/local", () => {
  return { default: () => ({ variable: "" }) };
});
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { generateMetadata as generateRootLayoutMetadata } from "@/app/layout";
import { generateMetadata as generateExploreLayoutMetadata } from "@/app/explore/layout";
import { generateMetadata as generateBestRoadsLayoutMetadata } from "./layout";

function serializedOpenGraph(
  metadata: Awaited<ReturnType<typeof generateCountryMetadata>>,
) {
  return JSON.stringify(metadata.openGraph);
}

describe("Best Roads metadata", () => {
  it("T23/T70: emits meta description and og:image for uppercase country URLs", async () => {
    const metadata = await generateCountryMetadata({
      params: Promise.resolve({ country: "CZ" }),
    });

    expect(metadata.description).toMatch(/top-rated motorcycle roads/i);
    expect(serializedOpenGraph(metadata)).toContain("/og/best-roads.svg");
  });

  it("adds og:image metadata for region and subregion Best Roads pages", async () => {
    const regionMetadata = await generateRegionMetadata({
      params: Promise.resolve({ country: "AT", region: "tyrol" }),
    });
    const subregionMetadata = await generateSubregionMetadata({
      params: Promise.resolve({
        country: "AT",
        region: "tyrol",
        subregion: "alpine-passes",
      }),
    });

    expect(serializedOpenGraph(regionMetadata)).toContain("/og/best-roads.svg");
    expect(serializedOpenGraph(subregionMetadata)).toContain(
      "/og/best-roads.svg",
    );
  });

  // Regression pin (transparency refactor, not red-green): the country,
  // region, and subregion pages now build their title/imageAlt through
  // t() + readLocale() instead of raw template literals. This pins the
  // exact English output so the ICU interpolation stays byte-identical.
  it("pins the exact English title/description/imageAlt for the country page", async () => {
    const metadata = await generateCountryMetadata({
      params: Promise.resolve({ country: "CZ" }),
    });

    expect(metadata.title).toBe(
      "Best motorcycle roads in Czech Republic — Tarmoto",
    );
    expect(metadata.description).toBe(
      "Ranked lists of the top-rated motorcycle roads in Czech Republic, scored by quality and curviness.",
    );
    expect(serializedOpenGraph(metadata)).toContain(
      '"alt":"Best motorcycle roads in Czech Republic"',
    );
  });

  it("pins the exact English catalog title, description, and imageAlt for the region page", async () => {
    const metadata = await generateRegionMetadata({
      params: Promise.resolve({ country: "AT", region: "tyrol" }),
    });

    expect(metadata.title).toBe("Best motorcycle roads in Tyrol — Tarmoto");
    expect(metadata.description).toContain("Austrian Alps");
    expect(serializedOpenGraph(metadata)).toContain(
      '"alt":"Best motorcycle roads in Tyrol"',
    );
  });

  it("pins the exact English catalog title, description, and imageAlt for the subregion page", async () => {
    const metadata = await generateSubregionMetadata({
      params: Promise.resolve({
        country: "AT",
        region: "tyrol",
        subregion: "alpine-passes",
      }),
    });

    expect(metadata.title).toBe(
      "Best motorcycle roads in Alpine Passes — Tarmoto",
    );
    expect(metadata.description).toContain("signature high passes");
    expect(serializedOpenGraph(metadata)).toContain(
      '"alt":"Best motorcycle roads in Alpine Passes"',
    );
  });
});

// Regression pin (transparency refactor, not red-green): these 3 layouts
// were static `export const metadata` objects with zero locale awareness
// before this task. Converting to `generateMetadata` must not change a
// single character of the English output.
describe("Static layout metadata (English regression pin)", () => {
  it("root layout.tsx pins the exact English title/description", async () => {
    const metadata = await generateRootLayoutMetadata();
    expect(metadata.title).toBe("Tarmoto");
    expect(metadata.description).toBe("Know the road before you ride it");
  });

  it("explore/layout.tsx pins the exact English title/description/siteName", async () => {
    const metadata = await generateExploreLayoutMetadata();
    expect(metadata.title).toBe("Road Quality Explorer — Tarmoto");
    expect(metadata.description).toBe(
      "Explore crowdsourced road surface quality and active hazards on an interactive map. Find the best riding roads before you head out.",
    );
    expect(metadata.openGraph?.siteName).toBe("Tarmoto");
  });

  it("roads/best/layout.tsx pins the exact English title/description/siteName", async () => {
    const metadata = await generateBestRoadsLayoutMetadata();
    expect(metadata.title).toBe("Best Motorcycle Roads — Tarmoto");
    expect(metadata.description).toBe(
      "Curated lists of the highest-rated motorcycle roads in each region, ranked by quality and curviness from crowdsourced rider data.",
    );
    expect(metadata.openGraph?.siteName).toBe("Tarmoto");
    expect(metadata.alternates).toEqual({
      canonical: "/roads/best",
      languages: { en: "/roads/best" },
    });
  });
});
