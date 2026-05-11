import { CommunitySubNav } from "@/components/CommunitySubNav";

/**
 * Shared layout for every `/community/*` view. Renders the community sub-nav
 * strip once at the top so the rider feed and saved route collections both
 * stay reachable from within the section — the cream sidebar lists
 * "Community" as a single top-level entry.
 */
export default function CommunityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4 md:px-6 md:pt-6">
        <CommunitySubNav />
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
