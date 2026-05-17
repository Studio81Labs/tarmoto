/**
 * Shared layout for every `/rides/*` view. Shell v2 (#572) replaced
 * the in-page sub-nav strip with expandable nav items inside the
 * primary sidebar — Stats, Road map, and Compare rides now live as
 * children of "Ride History" and auto-render whenever the rider is
 * inside the section. Nothing to render here; the layout exists
 * only to keep a stable Next.js route boundary.
 */
export default function RidesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
