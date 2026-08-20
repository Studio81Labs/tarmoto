import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { AppProviders } from "@/components/AppProviders";
import { RegisterServiceWorker } from "@/components/RegisterServiceWorker";
import { localeDirection } from "@/i18n";
import { readLocale, t } from "@/i18n/server";
import { readFormatPrefs } from "@/format/server";
import "./globals.css";

// Self-hosted fonts (#1211): the Google-hosted `next/font` loader fetches
// from the Google Fonts CDN during `next build`, which flakes in CI and
// fails in any offline environment. The committed .woff2 files are the
// same variable fonts the Google Fonts API served here before — built from
// google/fonts@e1118da94a8cb00cf6d06cdac9ef13eb1e5c6ab7 (TTF -> woff2, no
// glyph surgery; Fraunces' SOFT/WONK/opsz axes pinned to the API's serving
// values SOFT=0, WONK=1, opsz=14) and verified outline-identical to the
// previously served files at every weight the app uses. OFL licences sit
// next to the files. One file per family/style replaces Google's per-script
// slices, so coverage (latin, latin-ext, and the extra scripts Google
// declared) is unchanged.
const spaceGrotesk = localFont({
  src: "./fonts/space-grotesk/SpaceGrotesk-Variable.woff2",
  weight: "400 700",
  variable: "--font-sans",
});

const jetbrains = localFont({
  src: "./fonts/jetbrains-mono/JetBrainsMono-Variable.woff2",
  weight: "400 700",
  variable: "--font-mono",
});

const fraunces = localFont({
  src: [
    { path: "./fonts/fraunces/Fraunces-Variable.woff2", style: "normal" },
    {
      path: "./fonts/fraunces/Fraunces-Italic-Variable.woff2",
      style: "italic",
    },
  ],
  weight: "400 700",
  variable: "--font-serif",
  adjustFontFallback: "Times New Roman",
});

export async function generateMetadata(): Promise<Metadata> {
  const locale = await readLocale();
  return {
    title: t("Tarmoto", undefined, locale),
    description: t("Know the road before you ride it", undefined, locale),
    manifest: "/manifest.webmanifest",
    applicationName: "Tarmoto",
    appleWebApp: {
      capable: true,
      title: "Tarmoto",
      statusBarStyle: "default",
    },
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "any" },
        { url: "/favicon.svg", type: "image/svg+xml" },
        { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [
        { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
      ],
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#f5efe6",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await readLocale();
  const formatPrefs = await readFormatPrefs();
  return (
    <html
      lang={locale}
      dir={localeDirection(locale)}
      className={`${spaceGrotesk.variable} ${jetbrains.variable} ${fraunces.variable}`}
    >
      <body className="bg-cream text-ink font-sans antialiased">
        <RegisterServiceWorker />
        <AppProviders locale={locale} formatPrefs={formatPrefs}>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
