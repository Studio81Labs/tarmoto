import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  output: "static",
  integrations: [react()],
  vite: {
    optimizeDeps: {
      // Pre-bundle the React 19 CJS entries so `client:load` islands don't
      // race the dev server and see `react-dom/client` as a CJS module
      // without named exports.
      include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    },
    ssr: {
      noExternal: [],
    },
  },
});
