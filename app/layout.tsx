import type { Metadata, Viewport } from "next";
import "./globals.css";
import Providers from "./providers";

// 1-bit pixel Friend face (#111 on signal green), drawn on a 16x16 grid so it
// stays crisp at any favicon size.
const FACE_PIXELS =
  // head outline
  "M4 2h8v1H4zM3 3h1v1H3zM12 3h1v1h-1zM2 4h1v8H2zM13 4h1v8h-1zM3 12h1v1H3zM12 12h1v1h-1zM4 13h8v1H4z" +
  // eyes + smile
  "M5 6h2v2H5zM9 6h2v2H9zM5 10h1v1H5zM10 10h1v1h-1zM6 11h4v1H6z";
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" fill="#CCFF00"/><path d="${FACE_PIXELS}" fill="#111"/></svg>`,
  );

const DESCRIPTION =
  "A falling-block smasher starring your Rare Friend. Built for the Rare Friends Vibeathon — simulated $RAREFRIENDS economy.";

export const metadata: Metadata = {
  title: "Friend Smash",
  description: DESCRIPTION,
  applicationName: "Friend Smash",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Friend Smash" },
  other: { "mobile-web-app-capable": "yes" },
  icons: { icon: FAVICON },
  openGraph: {
    title: "Friend Smash",
    description: DESCRIPTION,
    siteName: "Friend Smash",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Friend Smash",
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#111111",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* Rare Friends house type: Silkscreen (display) + Sometype Mono (body). */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Root-layout font link applies to every route (the lint rule targets the Pages Router _document case). */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&family=Sometype+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
