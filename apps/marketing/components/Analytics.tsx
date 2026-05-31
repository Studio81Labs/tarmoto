import Script from "next/script";

const UMAMI_SRC = "https://analytics.studio81.cz/script.js";
const UMAMI_WEBSITE_ID = "5906f160-9f39-4f2b-a374-24a872f7442a";

export function Analytics() {
  return (
    <Script
      src={UMAMI_SRC}
      data-website-id={UMAMI_WEBSITE_ID}
      strategy="afterInteractive"
    />
  );
}
