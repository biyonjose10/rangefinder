import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rangefinder — deforestation alert triage",
  description:
    "Turns thousands of daily satellite deforestation alerts into one ranked, printable patrol order that rangers can actually drive to.",
  openGraph: {
    title: "Rangefinder",
    description:
      "Satellite alert triage for forest rangers. Built on NASA FIRMS, OpenStreetMap and Copernicus Sentinel-2.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0f0d",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
