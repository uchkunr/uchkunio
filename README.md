# uchkun.io

![Astro](https://img.shields.io/badge/Astro-7-FF5D01?logo=astro&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-38B2AC?logo=tailwind-css&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-F69220?logo=pnpm&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-000000?logo=vercel&logoColor=white)

Source for [uchkun.io](https://uchkun.io), the personal site and engineering blog of Uchkun Rakhimov.

## Overview

The site is built with Astro and ships as static HTML. Every route is prerendered at build time, so there is no database, no runtime API, and no required environment variables. Blog posts are Markdown files in the repository, validated against a typed schema during the build.

- **Content:** Markdown posts in an Astro content collection with a Zod schema.
- **Rendering:** All pages prerendered. No client framework; the few interactive parts are plain TypeScript.
- **Styling:** Tailwind CSS v4 over a small set of design tokens, with light and dark themes.
- **Navigation:** Astro View Transitions, with the post title moving into the header as you read.
- **Search:** Client-side filtering over the post list, with no index service.
- **SEO:** Per-page meta and Open Graph tags, JSON-LD structured data, sitemap, and RSS.
- **Social cards:** Open Graph images generated per post at build time with Satori and sharp.

## Requirements

- Node.js 22.12 or newer
- pnpm

## Getting started

```bash
pnpm install
pnpm dev
```

The dev server runs at http://localhost:4321. In Astro 7 it runs in the background, so stop it explicitly when you are done:

```bash
pnpm astro dev stop
```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the dev server |
| `pnpm build` | Build for production into `dist/` and `.vercel/output/` |
| `pnpm preview` | Serve the production build locally |
| `pnpm astro <cmd>` | Run any Astro CLI command |

## Writing a post

Create `src/content/blog/<slug>.md`. The filename becomes the URL: `/blog/<slug>`.

```yaml
---
title: "Post title"
date: "2026-07-01"
excerpt: "One or two sentences used in the post list, meta description, RSS, and OG image."
tags:
  - nodejs
  - performance
cover: "https://example.com/cover.jpg" # optional
---
```

Start the body with `##` headings. The page renders the title as the `<h1>`, and a table of contents appears when a post has more than two `##` or `###` headings.

Each post automatically gets its own page, tag pages, an RSS entry, a sitemap entry, and an OG image at `/og/<slug>.png`.

## Project structure

```text
src/
├── config/site.ts         Site metadata and links
├── content.config.ts      Blog collection schema
├── content/blog/          Markdown posts
├── layouts/BaseLayout.astro   Document shell and all client-side behavior
├── components/            Header, footer, post list, icons, SEO head
├── lib/                   Post loading, reading time, date formatting
├── pages/
│   ├── index.astro        Home
│   ├── blog/              Post list, post pages, tag pages
│   ├── og/[slug].png.ts   OG image generation
│   └── rss.xml.ts         RSS feed
└── styles/global.css      Tailwind entry, design tokens, prose styles
```

## Deployment

The site deploys to Vercel through the `@astrojs/vercel` adapter. A push to `master` triggers a production build. No environment variables are required.

## License

[MIT](LICENSE)
