import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import { AuthSync } from "@/components/AuthSync";
import { RealtimeProvider } from "@/components/RealtimeProvider";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Tarmoto",
  description: "Know the road before you ride it",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${jakarta.variable} ${jetbrains.variable}`}>
      <body className="bg-slate-950 text-slate-200 font-sans antialiased">
        <SessionProvider>
          <AuthSync />
          <RealtimeProvider />
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
