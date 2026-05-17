import type { paths } from "./generated/schema";

/**
 * Browser-safe view of the OpenAPI `paths` map.
 *
 * Strips `X-Internal-Token` (and any future internal-only header)
 * from every operation's `parameters.header` shape at the type
 * level. Browser consumers (companion, the future admin worker if
 * it ever runs in-browser) can't accidentally call internal-only
 * routes with a token they shouldn't have, because the header
 * required to authenticate them is type-`never` in this view.
 *
 * Today's Tarmoto API has no internal-only headers, so this is an
 * identity transform — the type structure exists so the day admin
 * work introduces such a route, both the client and the React
 * Query bindings already gate on it without any consumer-side
 * import change. Mirrors `@nexcue/openapi-client`'s same-named
 * pattern.
 */
export type BrowserSafePaths = {
  [Path in keyof paths]: {
    [Method in keyof paths[Path]]: BrowserSafeOperation<paths[Path][Method]>;
  };
};

type BrowserSafeOperation<Operation> = Operation extends {
  parameters: infer Params;
}
  ? Omit<Operation, "parameters"> & {
      parameters: BrowserSafeParameters<Params>;
    }
  : Operation;

type BrowserSafeParameters<Params> = Params extends object
  ? Omit<Params, "header"> &
      (Params extends { header: infer Header }
        ? { header?: WithoutInternalTokenHeader<Header> }
        : Params extends { header?: infer Header }
          ? { header?: WithoutInternalTokenHeader<Header> }
          : object)
  : Params;

type WithoutInternalTokenHeader<Header> =
  Header extends Record<string, unknown>
    ? Omit<Header, "X-Internal-Token"> extends infer Rest
      ? keyof Rest extends never
        ? never
        : Rest
      : never
    : Header;
