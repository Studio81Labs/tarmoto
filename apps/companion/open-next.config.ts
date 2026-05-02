import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Companion runs as a Cloudflare Worker via the OpenNext adapter.
//
// We deliberately leave incrementalCache unset: the companion has no
// ISR/SSG output today (every page is dynamic SSR or static export),
// so the in-memory default is sufficient and avoids pulling in an R2
// binding the operator would otherwise need to provision. Revisit if
// we add cached fetch / `revalidate` routes.
export default defineCloudflareConfig({});
