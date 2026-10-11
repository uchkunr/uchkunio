// @ts-check
import { defineConfig, fontProviders } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import vercel from "@astrojs/vercel";

export default defineConfig({
  site: "https://uchkun.io",
  output: "server",
  adapter: vercel(),
  integrations: [sitemap()],
  // Fetched at build time and served from this origin. Astro also generates
  // metric-matched fallbacks so text does not shift when the real font lands.
  fonts: [
    {
      provider: fontProviders.google(),
      name: "Outfit",
      cssVariable: "--font-outfit",
      weights: ["400 600"],
      styles: ["normal"],
      subsets: ["latin"],
      fallbacks: ["sans-serif"],
    },
  ],
  vite: {
    plugins: [tailwindcss()],
    // Pre-bundle the <ClientRouter /> modules up front. Otherwise Vite discovers
    // them on first page load, re-optimizes, and leaves the dev toolbar stuck on
    // a 504 "Outdated Optimize Dep" (Astro 7.3 + Vite 8.3).
    optimizeDeps: {
      include: [
        "astro/virtual-modules/transitions-events.js",
        "astro/virtual-modules/transitions-router.js",
        "astro/virtual-modules/transitions-swap-functions.js",
        "astro/virtual-modules/transitions-types.js",
      ],
    },
  },
  markdown: {
    shikiConfig: {
      themes: {
        light: "github-light",
        dark: "vesper",
      },
    },
  },
});
