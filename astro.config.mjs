// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import vercel from "@astrojs/vercel";
import keystatic from "@keystatic/astro";

export default defineConfig({
  site: "https://uchkun.io",
  output: "server",
  adapter: vercel(),
  integrations: [react(), sitemap(), keystatic()],
  vite: {
    plugins: [tailwindcss()],
    build: {
      chunkSizeWarningLimit: 1024,
    },
  },
  markdown: {
    shikiConfig: {
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
    },
  },
});
