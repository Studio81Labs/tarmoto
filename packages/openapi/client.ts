import createClient from "openapi-fetch";
import type { paths } from "./types.js";

export function createApiClient(options: {
  baseUrl: string;
  getToken?: () => string | null;
  onUnauthorized?: () => void;
}) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
  });

  client.use({
    async onRequest({ request }) {
      const token = options.getToken?.();
      if (token) {
        request.headers.set("Authorization", `Bearer ${token}`);
      }
      return request;
    },
    async onResponse({ response }) {
      if (response.status === 401) {
        options.onUnauthorized?.();
      }
      return response;
    },
  });

  return client;
}

export type { paths } from "./types.js";
export type ApiClient = ReturnType<typeof createApiClient>;
