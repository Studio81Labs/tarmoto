import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono, Fraunces } from "next/font/google";
import { AppProviders } from "@/components/AppProviders";
import { t } from "@/i18n";
import { readLocale } from "@/i18n/server";
import { readFormatPrefs } from "@/format/server";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-serif",
});

export async function generateMetadata(): Promise<Metadata> {
  const locale = await readLocale();
  return {
    title: t("Tarmoto", undefined, locale),
    description: t("Know the road before you ride it", undefined, locale),
  };
}

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
      className={`${spaceGrotesk.variable} ${jetbrains.variable} ${fraunces.variable}`}
    >
      <body className="bg-cream text-ink font-sans antialiased">
        <AppProviders locale={locale} formatPrefs={formatPrefs}>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
