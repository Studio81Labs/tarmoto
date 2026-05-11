import { RidesSubNav } from "@/components/RidesSubNav";

/**
 * Shared layout for every `/rides/*` view. Renders the rides sub-nav strip
 * once at the top so Stats, Road Map, and Compare keep an in-chrome path
 * to each other after the sidebar flattening (the cream sidebar lists
 * "Ride History" as a single top-level entry).
 */
export default function RidesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4 md:px-6 md:pt-6">
        <RidesSubNav />
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
