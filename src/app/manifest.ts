import type { MetadataRoute } from "next";

/**
 * Web app manifest — makes Moni installable to an Android/desktop home screen
 * as a standalone app (issue #6). Colours match the dark-navy theme in
 * globals.css so the splash/chrome don't flash white on launch. The icons are
 * navy-tile spades generated under public/ (see the same source as the favicon
 * in app/icon.png). A separate `maskable` icon carries the safe-zone padding
 * Android needs to mask it into a circle/squircle without clipping the crown.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Moni",
    short_name: "Moni",
    description: "Self-hosted, AI-native personal finance for Israeli households.",
    start_url: "/",
    display: "standalone",
    background_color: "#0c0e14",
    theme_color: "#0c0e14",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
