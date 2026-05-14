import { generateMetadata as generateCountryMetadata } from "./[country]/page";
import { generateMetadata as generateRegionMetadata } from "./[country]/[region]/page";
import { generateMetadata as generateSubregionMetadata } from "./[country]/[region]/[subregion]/page";

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
});
