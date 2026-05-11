import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

/**
 * Embed routes render standalone widgets inside third-party iframes and
 * intentionally keep the dark gradient palette they've always used. The
 * root layout puts `bg-cream` on `<body>` for the cream-themed app, which
 * would otherwise drag those widgets into the cream foreground remap in
 * `globals.css`.
 *
 * The marker class on this wrapper opts the embed subtree out of that
 * remap via the `body.bg-cream:not(:has(.tarmoto-embed))` anchor — see
 * the "Scoped foreground remap" block in `globals.css`.
 */
export default function EmbedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="tarmoto-embed">{children}</div>;
}
