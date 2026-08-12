import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "Moni",
  description: "Self-hosted, AI-native personal finance for Israeli households.",
};

// Tints the mobile browser chrome to match the app's dark navy (globals.css
// --color-background) rather than the OS default, and pins the viewport to the
// device width so pages lay out at true phone size. User zoom is left enabled
// deliberately — accessibility outranks a locked layout.
export const viewport: Viewport = {
  themeColor: "#0c0e14",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
