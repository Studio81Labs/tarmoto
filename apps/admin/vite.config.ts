import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // backend 3000, marketing 3001, companion 3002, admin 3003.
    port: 3003,
    strictPort: true,
    // Proxy /api/v1/* to the backend so cookies are first-party in dev.
    // Admin routes live at /api/v1/admin/... on the NestJS backend (port 3000).
    proxy: {
      "/api/v1": "http://localhost:3000",
    },
  },
  // @tarmoto/ui ships TypeScript/TSX source. Excluding it from pre-bundling
  // lets Vite (and Vitest) transform it through the normal plugin pipeline
  // (including @vitejs/plugin-react) rather than via esbuild-only pre-bundling.
  // pnpm workspace symlinks are dereferenced to their real path outside
  // node_modules, so @vitejs/plugin-react's exclude-node_modules guard does
  // not block the transform.
  optimizeDeps: {
    exclude: ["@tarmoto/ui"],
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
