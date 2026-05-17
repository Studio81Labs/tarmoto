import { expectTypeOf, test } from "vitest";
import type { paths } from "@tarmoto/openapi-client";
import { accountApi, explorationApi, tripsApi } from "./api";

type JsonResponse<
  Path extends keyof paths,
  Method extends keyof paths[Path],
  Status extends number,
> = paths[Path][Method] extends { responses: infer Responses }
  ? Status extends keyof Responses
    ? Responses[Status] extends { content: { "application/json": infer Body } }
      ? Body
      : void
    : never
  : never;

type JsonRequest<
  Path extends keyof paths,
  Method extends keyof paths[Path],
> = paths[Path][Method] extends {
  requestBody: { content: { "application/json": infer Body } };
}
  ? Body
  : never;

test("companion trips helpers expose generated OpenAPI contracts", () => {
  expectTypeOf<Parameters<typeof tripsApi.create>[0]>().toEqualTypeOf<
    JsonRequest<"/api/v1/trips", "post">
  >();
  expectTypeOf<Parameters<typeof tripsApi.importRoute>[0]>().toEqualTypeOf<
    JsonRequest<"/api/v1/trips/import", "post">
  >();
  expectTypeOf<Parameters<typeof tripsApi.update>[1]>().toEqualTypeOf<
    JsonRequest<"/api/v1/trips/{tripId}", "patch">
  >();
  expectTypeOf<Parameters<typeof tripsApi.generate>[1]>().toEqualTypeOf<
    JsonRequest<"/api/v1/trips/{tripId}/generate", "post">
  >();

  expectTypeOf<
    Awaited<ReturnType<typeof tripsApi.list>>["data"]
  >().toEqualTypeOf<JsonResponse<"/api/v1/trips", "get", 200>>();
  expectTypeOf<
    Awaited<ReturnType<typeof tripsApi.get>>["data"]
  >().toEqualTypeOf<JsonResponse<"/api/v1/trips/{tripId}", "get", 200>>();
  expectTypeOf<
    Awaited<ReturnType<typeof tripsApi.join>>["data"]
  >().toEqualTypeOf<JsonResponse<"/api/v1/trips/{tripId}/join", "post", 201>>();
  expectTypeOf<
    Awaited<ReturnType<typeof tripsApi.duplicate>>["data"]
  >().toEqualTypeOf<
    JsonResponse<"/api/v1/trips/{tripId}/duplicate", "post", 201>
  >();
});

test("companion exploration helpers expose generated OpenAPI contracts", () => {
  expectTypeOf<
    Awaited<ReturnType<typeof explorationApi.getStats>>["data"]
  >().toEqualTypeOf<JsonResponse<"/api/v1/exploration/stats", "get", 200>>();
  expectTypeOf<
    Awaited<ReturnType<typeof explorationApi.getRiddenIds>>["data"]
  >().toEqualTypeOf<
    JsonResponse<"/api/v1/exploration/ridden-ids", "get", 200>
  >();
  expectTypeOf<
    Awaited<ReturnType<typeof explorationApi.getRiddenSegments>>["data"]
  >().toEqualTypeOf<
    JsonResponse<"/api/v1/exploration/ridden-segments", "get", 200>
  >();
  expectTypeOf<
    Awaited<ReturnType<typeof explorationApi.getNearbyUnridden>>["data"]
  >().toEqualTypeOf<
    JsonResponse<"/api/v1/exploration/nearby-unridden", "get", 200>
  >();
});

test("companion account helpers expose generated OpenAPI contracts", () => {
  expectTypeOf<
    Awaited<ReturnType<typeof accountApi.getSubscription>>["data"]
  >().toEqualTypeOf<JsonResponse<"/api/v1/account/subscription", "get", 200>>();
  expectTypeOf<
    Parameters<typeof accountApi.createCheckoutSession>[0]
  >().toEqualTypeOf<
    JsonRequest<"/api/v1/account/subscription/checkout", "post">
  >();
  expectTypeOf<
    Awaited<ReturnType<typeof accountApi.getBikes>>["data"]
  >().toEqualTypeOf<JsonResponse<"/api/v1/account/bikes", "get", 200>>();
  expectTypeOf<Parameters<typeof accountApi.addBike>[0]>().toEqualTypeOf<
    JsonRequest<"/api/v1/account/bikes", "post">
  >();
  expectTypeOf<Parameters<typeof accountApi.updateBike>[1]>().toEqualTypeOf<
    JsonRequest<"/api/v1/account/bikes/{id}", "patch">
  >();
  expectTypeOf<
    Awaited<ReturnType<typeof accountApi.requestDataExport>>["data"]
  >().toEqualTypeOf<JsonResponse<"/api/v1/account/data-export", "post", 202>>();
  expectTypeOf<
    Awaited<ReturnType<typeof accountApi.getDataExport>>["data"]
  >().toEqualTypeOf<
    JsonResponse<"/api/v1/account/data-export/{id}", "get", 200>
  >();
});
