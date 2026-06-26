import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3004,
    // Proxy /api/v1/* to the backend so cookies are first-party in dev.
    // Admin routes live at /api/v1/admin/... on the NestJS backend (port 3000).
    proxy: {
      "/api/v1": "http://localhost:3000",
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
