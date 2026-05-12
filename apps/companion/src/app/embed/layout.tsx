import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

/**
 * Embed routes render standalone widgets inside third-party iframes and
 * intentionally keep the dark slate palette they've always used. The
 * root layout puts `bg-cream` on `<body>` for the cream-themed app,
 * which would otherwise drag those widgets into the cream foreground /
 * background remap in `globals.css`.
 *
 * The `.tarmoto-no-cream` marker on this wrapper opts the embed subtree
 * out of every `body.bg-cream:not(:has(.tarmoto-no-cream))` rule. The
 * same marker is reused by the public unauthenticated layouts
 * (`/explore`, `/discover`, `/roads/best`) which also render dark slate
 * shells until the rider signs in.
 *
 * `min-h-screen bg-slate-950` paints the iframe canvas dark even when
 * the embedded widget is shorter than the iframe viewport — without it
 * the cream `<body>` shows through the gap around / below compact
 * widgets.
 */
export default function EmbedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="tarmoto-no-cream min-h-screen bg-slate-950">{children}</div>
  );
}
