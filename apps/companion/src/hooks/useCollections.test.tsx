import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { FormatProvider } from "@/format/FormatProvider";
import {
  routeCollectionsApi,
  type CreateRouteCollectionInput,
  type RouteCollectionDetail,
  type RouteCollectionSummary,
} from "@/lib/api";
import {
  COLLECTIONS_LIBRARY_QUERY_PREFIX,
  useCollections,
  type UseCollectionsResult,
} from "./useCollections";
import { withQueryClient } from "./test-utils";

vi.mock("@/lib/api", () => ({
  routeCollectionsApi: {
    listLibrary: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    unfollow: vi.fn(),
  },
}));

const USER_ID = "user-1";
let latestResult: UseCollectionsResult;

function summary(
  overrides: Partial<RouteCollectionSummary> = {},
): RouteCollectionSummary {
  return {
    id: "z-road",
    owner_id: USER_ID,
    title: "Z-road",
    description: null,
    visibility: "private",
    slug: "zRoad123456",
    item_count: 0,
    owner_name: null,
    created_at: "2026-04-15T10:00:00.000Z",
    updated_at: "2026-04-15T10:00:00.000Z",
    ...overrides,
  };
}

function detail(
  overrides: Partial<RouteCollectionDetail> = {},
): RouteCollectionDetail {
  return {
    id: "a-ring",
    owner_id: USER_ID,
    title: "Åland",
    description: null,
    visibility: "private",
    slug: "aRing123456",
    item_count: 0,
    items: [],
    follower_count: 0,
    owner_name: null,
    viewer_is_owner: true,
    viewer_is_following: false,
    created_at: "2026-04-15T10:00:00.000Z",
    updated_at: "2026-04-15T10:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function Harness() {
  latestResult = useCollections(USER_ID);
  return (
    <>
      <div data-testid="owned">
        {latestResult.collections
          .map((collection) => collection.title)
          .join(",")}
      </div>
      <div data-testid="followed">
        {latestResult.followed.map((collection) => collection.title).join(",")}
      </div>
    </>
  );
}

function App({ locale }: { locale: string }) {
  return (
    <FormatProvider
      formatLocale={locale}
      timeZone="Europe/Prague"
      units="metric"
    >
      <Harness />
    </FormatProvider>
  );
}

function cachedTitles(client: QueryClient, locale: string): string[] {
  const data = client.getQueryData<{
    owned: Array<{ title: string }>;
  }>([...COLLECTIONS_LIBRARY_QUERY_PREFIX, USER_ID, locale]);
  return data?.owned.map((collection) => collection.title) ?? [];
}

function cachedFollowedTitles(client: QueryClient, locale: string): string[] {
  const data = client.getQueryData<{
    followed: Array<{ title: string }>;
  }>([...COLLECTIONS_LIBRARY_QUERY_PREFIX, USER_ID, locale]);
  return data?.followed.map((collection) => collection.title) ?? [];
}

function createPersistentQueryClient(): QueryClient {
  // Keep inactive locale entries alive, matching React Query's production
  // cache window, so assertions cover both abandoned and active keys.
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Number.POSITIVE_INFINITY,
        refetchOnMount: true,
      },
      mutations: { retry: false },
    },
  });
}

describe("useCollections", () => {
  beforeEach(() => {
    vi.mocked(routeCollectionsApi.listLibrary).mockReset();
    vi.mocked(routeCollectionsApi.create).mockReset();
    vi.mocked(routeCollectionsApi.update).mockReset();
    vi.mocked(routeCollectionsApi.delete).mockReset();
    vi.mocked(routeCollectionsApi.unfollow).mockReset();
    vi.mocked(routeCollectionsApi.listLibrary).mockResolvedValue({
      data: { owned: [summary()], followed: [] },
    } as Awaited<ReturnType<typeof routeCollectionsApi.listLibrary>>);
  });

  it("writes an in-flight mutation to every locale cache for the user", async () => {
    const createRequest =
      deferred<Awaited<ReturnType<typeof routeCollectionsApi.create>>>();
    vi.mocked(routeCollectionsApi.create).mockReturnValue(
      createRequest.promise,
    );
    const queryClient = createPersistentQueryClient();
    const wrapper = withQueryClient(queryClient);
    const view = render(<App locale="en" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("owned")).toHaveTextContent("Z-road");
    });

    let mutation!: Promise<unknown>;
    act(() => {
      mutation = latestResult.createCollection({
        title: "Åland",
        visibility: "private",
      } as CreateRouteCollectionInput);
    });

    view.rerender(<App locale="sv" />);
    await waitFor(() => {
      expect(routeCollectionsApi.listLibrary).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("owned")).toHaveTextContent("Z-road");
    });

    await act(async () => {
      createRequest.resolve({ data: detail() });
      await mutation;
    });

    expect(cachedTitles(queryClient, "en")).toEqual(["Åland", "Z-road"]);
    expect(cachedTitles(queryClient, "sv")).toEqual(["Z-road", "Åland"]);
    await waitFor(() => {
      expect(screen.getByTestId("owned")).toHaveTextContent("Z-road,Åland");
    });
  });

  it("ignores a stale locale list response that resolves after the mutation", async () => {
    const staleLocaleList =
      deferred<Awaited<ReturnType<typeof routeCollectionsApi.listLibrary>>>();
    vi.mocked(routeCollectionsApi.listLibrary)
      .mockResolvedValueOnce({
        data: { owned: [summary()], followed: [] },
      } as Awaited<ReturnType<typeof routeCollectionsApi.listLibrary>>)
      .mockReturnValueOnce(staleLocaleList.promise);
    const createRequest =
      deferred<Awaited<ReturnType<typeof routeCollectionsApi.create>>>();
    vi.mocked(routeCollectionsApi.create).mockReturnValue(
      createRequest.promise,
    );
    const queryClient = createPersistentQueryClient();
    const wrapper = withQueryClient(queryClient);
    const view = render(<App locale="en" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("owned")).toHaveTextContent("Z-road");
    });

    let mutation!: Promise<unknown>;
    act(() => {
      mutation = latestResult.createCollection({
        title: "Åland",
        visibility: "private",
      } as CreateRouteCollectionInput);
    });
    view.rerender(<App locale="sv" />);
    await waitFor(() => {
      expect(routeCollectionsApi.listLibrary).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      createRequest.resolve({ data: detail() });
      await mutation;
    });
    expect(cachedTitles(queryClient, "sv")).toEqual(["Z-road", "Åland"]);
    await waitFor(() => {
      expect(screen.getByTestId("owned")).toHaveTextContent("Z-road,Åland");
    });

    await act(async () => {
      staleLocaleList.resolve({
        data: { owned: [summary()], followed: [] },
      } as Awaited<ReturnType<typeof routeCollectionsApi.listLibrary>>);
      await staleLocaleList.promise;
      await Promise.resolve();
    });

    expect(cachedTitles(queryClient, "sv")).toEqual(["Z-road", "Åland"]);
    await waitFor(() => {
      expect(screen.getByTestId("owned")).toHaveTextContent("Z-road,Åland");
    });
  });

  it("removes a followed collection from a locale cache created during the request", async () => {
    const followed = summary({
      id: "followed-1",
      owner_id: "other-user",
      title: "Saved Alps",
    });
    vi.mocked(routeCollectionsApi.listLibrary).mockResolvedValue({
      data: { owned: [], followed: [followed] },
    } as Awaited<ReturnType<typeof routeCollectionsApi.listLibrary>>);
    const unfollowRequest =
      deferred<Awaited<ReturnType<typeof routeCollectionsApi.unfollow>>>();
    vi.mocked(routeCollectionsApi.unfollow).mockReturnValue(
      unfollowRequest.promise,
    );
    const queryClient = createPersistentQueryClient();
    const wrapper = withQueryClient(queryClient);
    const view = render(<App locale="en" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("followed")).toHaveTextContent("Saved Alps");
    });

    let mutation!: Promise<unknown>;
    act(() => {
      mutation = latestResult.unfollowCollection(followed.id);
    });
    await waitFor(() => {
      expect(screen.getByTestId("followed")).toBeEmptyDOMElement();
    });

    view.rerender(<App locale="sv" />);
    await waitFor(() => {
      expect(routeCollectionsApi.listLibrary).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("followed")).toHaveTextContent("Saved Alps");
    });

    await act(async () => {
      unfollowRequest.resolve({ data: undefined });
      await mutation;
    });

    expect(cachedFollowedTitles(queryClient, "en")).toEqual([]);
    expect(cachedFollowedTitles(queryClient, "sv")).toEqual([]);
    await waitFor(() => {
      expect(screen.getByTestId("followed")).toBeEmptyDOMElement();
    });
  });
});
