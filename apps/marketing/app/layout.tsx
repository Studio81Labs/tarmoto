import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono, Fraunces } from "next/font/google";
import { Analytics } from "@/components/Analytics";
import { CookieBanner } from "@/components/CookieBanner";
import { WaitlistProvider } from "@/components/WaitlistProvider";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space-grotesk",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-fraunces",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://tarmoto.app"),
  applicationName: "Tarmoto",
  title: {
    default: "Tarmoto · A better way to plan motorcycle rides",
    template: "%s · Tarmoto",
  },
  description:
    "Tarmoto is a desktop-first motorcycle route planner. Built for twisty roads, surface awareness, and fewer surprises. Sync the route to your phone companion and ride.",
  manifest: "/site.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Tarmoto",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-48x48.png", sizes: "48x48", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    type: "website",
    title: "Tarmoto · A better way to plan motorcycle rides",
    description:
      "A desktop-first motorcycle route planner. Twisty without the broken asphalt.",
  },
};

export const viewport: Viewport = {
  themeColor: "#0B0D10",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} ${fraunces.variable}`}
    >
      <body>
        <WaitlistProvider>{children}</WaitlistProvider>
        <CookieBanner />
        <Analytics />
      </body>
    </html>
  );
}
