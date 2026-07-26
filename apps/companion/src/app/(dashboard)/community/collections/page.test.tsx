import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { FormatProvider } from "@/format/FormatProvider";
import { I18nProvider } from "@/i18n/I18nProvider";
import type { RouteCollectionView } from "@/lib/route-collections";
import RouteCollectionsPage from "./page";

const mocks = vi.hoisted(() => ({
  useCollections: vi.fn(),
}));

vi.mock("@/hooks/useCollections", () => ({
  useCollections: (...args: unknown[]) => mocks.useCollections(...args),
}));

vi.mock("@/components/community/CollectionsDiscover", () => ({
  CollectionsDiscover: () => null,
}));

vi.mock("../_CommunityScaffold", () => ({
  CommunityScaffold: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function collection(id: string, title: string): RouteCollectionView {
  return {
    id,
    ownerId: "rider-1",
    ownerName: "Rider",
    title,
    description: null,
    visibility: "private",
    slug: id,
    rideRefs: [],
    rideIds: [],
    itemCount: 0,
    followerCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function RegionalLocaleWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en">
      <FormatProvider formatLocale="tr-TR" timeZone="UTC" units="metric">
        {children}
      </FormatProvider>
    </I18nProvider>
  );
}

describe("route collections regional search", () => {
  it("uses the regional locale when the UI language falls back to English", async () => {
    mocks.useCollections.mockReturnValue({
      collections: [
        collection("izmir", "İzmir"),
        collection("ankara", "Ankara"),
      ],
      followed: [],
      status: "ready",
      errorMessage: null,
      refresh: vi.fn(),
      createCollection: vi.fn(),
      updateCollection: vi.fn(),
      removeCollection: vi.fn(),
      unfollowCollection: vi.fn(),
    });

    render(<RouteCollectionsPage />, { wrapper: RegionalLocaleWrapper });

    await userEvent.type(
      screen.getByRole("textbox", { name: "Search collections" }),
      "izmir",
    );

    expect(screen.getByText("İzmir")).toBeInTheDocument();
    expect(screen.queryByText("Ankara")).not.toBeInTheDocument();
  });
});
