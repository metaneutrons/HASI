import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://hasi.metaneutrons.cc"),
  title: "HASI — Dein Campus, klarer organisiert",
  description:
    "Der Hochschulassistent für Räume, Services und den Alltag an der Hochschule Hannover.",
  applicationName: "HASI",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f2" },
    { media: "(prefers-color-scheme: dark)", color: "#111211" },
  ],
};

const themeBootstrap = `(() => {
  try {
    const saved = window.localStorage.getItem('hasi-theme-v1');
    const theme = saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
    document.documentElement.dataset.theme = theme;
  } catch {
    document.documentElement.dataset.theme = 'system';
  }
})();`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="de" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
