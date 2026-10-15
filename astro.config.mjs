// @ts-check
import { defineConfig, fontProviders } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import vercel from "@astrojs/vercel";

export default defineConfig({
  site: "https://uchkun.io",
  // One URL per page: internal links, hreflang, canonical and the sitemap all omit the slash,
  // and Vercel redirects /path/ to /path.
  trailingSlash: "never",
  output: "server",
  adapter: vercel(),
  // Posts are written in Uzbek at /blog/<slug>; translations live under /en/ and /ru/.
  // Keep in sync with LOCALES in src/lib/posts.ts.
  i18n: {
    locales: ["uz", "en", "ru"],
    defaultLocale: "uz",
    routing: { prefixDefaultLocale: false },
  },
  // Pairs /blog/<slug> with /en/blog/<slug> and /ru/blog/<slug> as hreflang alternates.
  integrations: [
    sitemap({
      i18n: { defaultLocale: "uz", locales: { uz: "uz", en: "en", ru: "ru" } },
    }),
  ],
  // Fetched at build time and served from this origin. Astro also generates
  // metric-matched fallbacks so text does not shift when the real font lands.
  fonts: [
    {
      provider: fontProviders.google(),
      // Jost covers Latin (with Uzbek oʻ and gʻ) and Cyrillic, so one family serves every language.
      name: "Jost",
      cssVariable: "--font-jost",
      weights: ["400 600"],
      styles: ["normal"],
      subsets: ["latin", "cyrillic"],
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
