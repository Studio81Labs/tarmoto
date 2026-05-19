// `/community/*` shares no chrome of its own anymore — the sidebar's
// non-clickable "Community" group lists Feed + Collections directly, so
// the rider has one source of navigation rather than a sidebar entry
// plus a duplicated in-page tab strip.
export default function CommunityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
