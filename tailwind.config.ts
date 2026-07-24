import type { Config } from "tailwindcss";

// Tailwind v4 is CSS-first (see src/app/globals.css `@import "tailwindcss"`);
// this file only exists to pin the content scan paths explicitly and is
// wired in via `@config` in globals.css.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
};

export default config;
