import { redirect } from "next/navigation";

// `/community` has no overview page of its own — the section lives at
// `/community/feed` and `/community/collections`, and the sidebar lists
// both as siblings under a non-clickable "Community" group. Anyone who
// lands on `/community` (legacy links, root-of-section bookmarks) gets
// the feed.
export default function CommunityRoot() {
  redirect("/community/feed");
}
