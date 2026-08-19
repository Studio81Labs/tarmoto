import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono, Fraunces } from "next/font/google";
import { AppProviders } from "@/components/AppProviders";
import { RegisterServiceWorker } from "@/components/RegisterServiceWorker";
import { localeDirection } from "@/i18n";
import { readLocale, t } from "@/i18n/server";
import { readFormatPrefs } from "@/format/server";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
});

const fraunces = Fraunces({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-serif",
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
