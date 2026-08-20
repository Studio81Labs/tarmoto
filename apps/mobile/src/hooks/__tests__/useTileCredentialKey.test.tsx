/**
 * The signal both map screens fold into their quality `VectorSource` key
 * (#1279), so the source REMOUNTS when tiles start — or stop — being fetched
 * as this rider. Without it, tiles fetched before the credential landed stay in
 * MapLibre's cache free-capped: the native URL transform changes neither the
 * source URL nor its cache key, so nothing else would ever refetch them.
 */

jest.mock("@maplibre/maplibre-react-native", () => ({
  TransformRequestManager: {
    addUrlSearchParam: jest.fn(),
    removeUrlSearchParam: jest.fn(),
  },
}));

import { act, renderHook } from "@testing-library/react-native";
import { applyTileToken } from "@/services/tileAuth";
import { useTileCredentialKey } from "../useTileCredentialKey";

const API = "https://api.example.test";

const publish = async (token: string | null) => {
  await act(async () => {
    applyTileToken(token, token === null ? 0 : 900, API);
  });
};

describe("useTileCredentialKey", () => {
  beforeEach(() => {
    applyTileToken(null);
  });

  it("reads 'anon' until a credential is published", async () => {
    const { result } = await renderHook(() => useTileCredentialKey());

    expect(result.current).toBe("anon");
  });

  it("changes when the credential arrives, forcing a source remount", async () => {
    const { result } = await renderHook(() => useTileCredentialKey());
    expect(result.current).toBe("anon");

    await publish("tok-1");

    expect(result.current).toBe("authed");
  });

  it("does NOT change on a rotation — those tiles are already this rider's", async () => {
    const { result } = await renderHook(() => useTileCredentialKey());
    await publish("tok-1");
    const afterFirst = result.current;

    await publish("tok-2");

    expect(result.current).toBe(afterFirst);
  });

  it("changes back when the credential is withdrawn", async () => {
    const { result } = await renderHook(() => useTileCredentialKey());
    await publish("tok-1");
    expect(result.current).toBe("authed");

    await publish(null);

    expect(result.current).toBe("anon");
  });
});
