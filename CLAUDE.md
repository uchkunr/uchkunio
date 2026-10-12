# CLAUDE.md

Guidance for working in this repository. Read it before making changes.

## Project

`uchkun.io` is the personal site and engineering blog of Uchkun Rakhimov, a backend engineer. It is an Astro 7 site deployed to Vercel. Content is Markdown in the repo. There is no database, no auth, no runtime API, and no required environment variables.

| Layer | Choice |
| --- | --- |
| Framework | Astro 7 (`output: "server"`, every route prerendered) |
| UI | Tailwind CSS v4 plus hand-written CSS in `global.css`. No client framework: all interactivity is vanilla TypeScript in Astro `<script>` tags |
| Fonts | Outfit via Astro's `fonts` config (Google provider, self-hosted at build). Code uses the system monospace stack |
| Language | TypeScript, `astro/tsconfigs/strict` |
| Package manager | **pnpm** (not npm, yarn, or bun) |
| Hosting | Vercel via `@astrojs/vercel` |
| OG images | Satori + sharp, generated at build time |

## Commands

```bash
pnpm install          # install from pnpm-lock.yaml
pnpm dev              # dev server on http://localhost:4321 (runs in the background)
pnpm astro dev stop   # stop the background dev server
pnpm astro dev logs   # read dev server logs
pnpm build            # production build; this is the only verification gate
pnpm preview          # serve the production build
```

There is no test suite, linter, or type-check script. `pnpm build` validates every post against the content schema and renders every route, so a green build is the minimum bar for any change. It does not type-check: Astro strips types without checking them. Rely on your editor's TypeScript server, or add `@astrojs/check` and `typescript` as dev dependencies if a check step is needed.

Astro 7 runs `astro dev` as a background process. If `pnpm dev` reports "Another astro dev server is already running", stop the existing one with `pnpm astro dev stop` instead of using `--force` or picking another port.

## Architecture

**Static first.** `astro.config.mjs` sets `output: "server"`, but every page and endpoint declares `export const prerender = true`. The build emits static HTML plus a single Vercel function (`_render`) that only serves `/_image` and server islands. Keep it that way:

- Every new page or endpoint must export `prerender = true`. Without it, the route silently becomes a serverless function.
- Only opt a route into SSR (`prerender = false`) when it genuinely needs request-time data, and call that out in the change.

**Routes**

| Route | Source | Notes |
| --- | --- | --- |
| `/` | `src/pages/index.astro` | Bio, latest posts, links. Person and WebSite JSON-LD |
| `/blog` | `src/pages/blog/index.astro` | Posts grouped by year, client-side search (`/` focuses it, `?q=` prefills it) |
| `/blog/[slug]` | `src/pages/blog/[slug].astro` | Post page (Uzbek original): title moves into the header on scroll, progress line, TOC at `xl` and up, code copy, prev/next, language links |
| `/en/blog/[slug]`, `/ru/blog/[slug]` | `src/pages/[lang]/blog/[slug].astro` | Translated post page, same `PostLayout`, prev/next within the language |
| `/blog/tags/[tag]` | `src/pages/blog/tags/[tag].astro` | Posts filtered by tag |
| `/og/[...slug].png` | `src/pages/og/[...slug].png.ts` | 1200x630 OG image per post and language (`/og/<slug>.png`, `/og/en/<slug>.png`) |
| `/rss.xml` | `src/pages/rss.xml.ts` | RSS feed |
| `/404` | `src/pages/404.astro` | Not found page |
| `/sitemap-index.xml` | `@astrojs/sitemap` | Generated at build, not available in dev |

**Client runtime.** `BaseLayout.astro` mounts `<ClientRouter />` (View Transitions), and one bundled `<script>` in the same file owns every behavior on the site. Rules that follow from that:

- Bundled scripts run once per visit, not once per page. Per-page setup is registered on `astro:page-load` (which also fires on the first load). Delegated `document` listeners are registered once at module level.
- Window listeners leak across navigations. Add them through `onScroll()` or push a teardown into `cleanups`; both are drained on `astro:before-swap`.
- The router copies `<html>` attributes from the incoming page, which drops the `dark` class. The layout re-applies it on `astro:after-swap`. Do not duplicate that logic elsewhere.
- `is:inline` scripts are for code that must run before first paint (the theme class). They execute once unless marked `data-astro-rerun`.
- Theme is a `dark` class on `<html>`, persisted in `localStorage.theme`. Switching it runs inside `document.startViewTransition` for a crossfade.

## Where things live

| Task | File |
| --- | --- |
| Site name, description, URL, OG default, Twitter handle | `src/config/site.ts` (`SITE`) |
| Links on the home page and JSON-LD `sameAs` | `src/config/site.ts` (`SOCIAL_LINKS`) |
| Home page copy | `src/pages/index.astro` (bio paragraphs are inline) |
| Blog post | `src/content/blog/<slug>.md` (Uzbek), `src/content/blog/{en,ru}/<slug>.md` (translations) |
| Post page markup, language links, `hreflang` | `src/layouts/PostLayout.astro` |
| Locales, slugs, post URLs, translations lookup | `src/lib/posts.ts` (`LOCALES`, `localeOf`, `slugOf`, `postUrl`, `getTranslations`) |
| Frontmatter schema | `src/content.config.ts` |
| Fonts | `astro.config.mjs` (`fonts`), loaded with `<Font>` in `BaseLayout.astro` |
| Layout and every client-side behavior | `src/layouts/BaseLayout.astro` |
| Header: nav, theme toggle, reading title, progress line | `src/components/Header.astro` |
| Footer: RSS and source link | `src/components/Footer.astro` |
| Post rows shared by home, blog, and tag pages | `src/components/PostList.astro` |
| Inline SVG icons | `src/components/Icon.astro` |
| Meta, Open Graph, Twitter tags | `src/components/SEOHead.astro` |
| Breadcrumb JSON-LD | `src/components/Breadcrumbs.astro` |
| Vercel Web Analytics | `<Analytics />` from `@vercel/analytics/astro` at the end of `<body>` in `BaseLayout.astro` |
| Design tokens, motion, component and prose styles | `src/styles/global.css` |
| Post loading, sorting, reading time, year grouping | `src/lib/posts.ts` |
| Date formatting | `src/lib/date.ts` |
| OG image template | `src/pages/og/[...slug].png.ts` |
| Static assets, favicons, search engine verification files | `public/` |

Nav links are written directly in `Header.astro`. Keep `site.ts`, `Icon.astro`, and `src/components/` free of dead exports: delete code when its last caller goes away instead of keeping it for later.

## Content

Posts are loaded by a `glob` loader from `src/content/blog/**/*.md`. The schema is enforced at build time, so an invalid post fails the build.

```yaml
---
title: "Post title"          # required, rendered as the page <h1>
date: "YYYY-MM-DD"           # required, a string, not a YAML date
excerpt: "One or two sentences." # required, used in list, meta description, RSS, OG image
tags:                        # required, lowercase, hyphenated
  - nodejs
cover: "https://..."         # optional, full-bleed hero image
---
```

Rules:

- **Slug** is the filename and the URL. Lowercase, digits, and hyphens only. Descriptive, never date-prefixed (`redis-beyond-caching`, not `2026-01-redis`).
- **No `#` H1 in the body.** The page already renders `title` as the `<h1>`. Start sections at `##`.
- The table of contents renders when a post has more than two headings at depth 3 or less.
- Every fenced code block declares a language. Shiki highlights with `github-light` and `github-dark-dimmed`.
- Reading time is computed at 230 words per minute from the raw body.
- Changing a slug changes a public URL. Treat it as a breaking change.
- **Translations.** Posts are written in Uzbek; a translation is the same filename under `en/` or `ru/` (`src/content/blog/en/<slug>.md` serves `/en/blog/<slug>`). Frontmatter is identical except `title` and `excerpt`; code blocks stay identical except human-language comments and output text; links to other posts point to the same language. `getPosts()` returns Uzbek posts only, so lists, tags and RSS never mix languages. The site chrome is English and is not translated.
- `<html lang>` and `og:locale` follow the post's language; every post page emits `hreflang` alternates with `x-default` pointing at the Uzbek original.
- Outfit has no Cyrillic. On pages the browser falls back to the system font for Russian text; OG images load Noto Sans as a fallback font for the same reason.

Writing style for posts and docs:

- One concept in depth over a broad survey. Real, runnable code over pseudocode.
- Get to the point. No throat-clearing intros, no filler conclusions.
- Do not use em dashes (U+2014) or en dashes (U+2013). Use a colon, comma, parentheses, or a new sentence.

## Code conventions

- Path alias `@/*` maps to `src/*`. Use it instead of relative paths across directories.
- Everything is `.astro`. There is no React. Do not add a UI framework for something a few lines of script can do.
- Tailwind utilities handle layout and spacing inside templates. Anything with a transition, a hover state, or more than one rule that repeats gets a class in `global.css` (`.row`, `.search`, `.toc`, `.code`). No CSS modules, no `<style>` blocks in components.
- Color comes only from the tokens in `global.css`: `--bg`, `--fg`, `--fg-2`, `--fg-3`, `--line`, `--fill`, `--ok`. No new colors, no gradients, no shadows. The palette is the design.
- Motion has one easing (`--swift`), 200 to 300ms for feedback, 600 to 700ms for entrances. Entrance order is `data-reveal` with `--i`. Every animation must communicate state (hover target, progress, position); decorative motion is not added. The `prefers-reduced-motion` block at the end of `global.css` zeroes all durations, so new animations are covered automatically.
- Hover highlight on a list: wrap it in `[data-list]` and mark each link `[data-row]`. The layout script does the rest.
- `is:inline` scripts are not bundled or transpiled. Keep them short and ES5-style, as the existing ones are.
- Commits follow Conventional Commits as used in history: `feat:`, `fix:`, `refactor:`, `docs:`, `content:`, `chore(deps):`.

## Dependencies

- Use pnpm for every install and removal. Never create `package-lock.json`, `yarn.lock`, or `bun.lock`.
- `dependencies` holds anything imported by site code or used by Astro at runtime: Astro, its integrations, the Vercel adapter, `@vercel/analytics`, and the OG image stack (`satori`, `satori-html`, `sharp`).
- `devDependencies` holds build-only tooling: Tailwind and its Vite plugin. `@vercel/analytics` is the only package that ships code to the browser.
- Do not add `@types/*` packages for libraries that ship their own types.
- Do not downgrade packages to fix a problem. Find the root cause and fix it in config or code.
- `pnpm-workspace.yaml` holds pnpm supply-chain settings: `allowBuilds` (packages allowed to run install scripts) and `minimumReleaseAgeExclude` (pinned exceptions to the minimum release age). A new package with an install script or a very recent release may need an entry there.

## Known gotchas

- **Vite dep optimization and View Transitions.** `astro.config.mjs` pre-bundles the `astro/virtual-modules/transitions-*` modules via `vite.optimizeDeps.include`. Without it, Vite discovers them on first load, re-optimizes, and the dev toolbar gets stuck on a 504 "Outdated Optimize Dep" with Astro 7.3 and Vite 8.3. Keep this until a newer Astro or Vite release fixes it, and verify by loading a page and checking that no request returns 504.
- **The build needs network access.** Astro's Google font provider downloads Outfit at build time, and the OG template fetches it separately for Satori (which needs TTF). The OG endpoint falls back to a system font; the font provider does not.
- **Analytics** uses the official `@vercel/analytics/astro` component. It renders a `<vercel-analytics>` custom element, so every client-side navigation swaps in a new one and records a pageview with the route pattern (`/blog/[slug]`), not just the path. Keep it at the end of `<body>`, not in `<head>` as Vercel's docs show: the HTML parser closes `<head>` at the first custom element, which moves the stylesheet and every later head tag into `<body>`. It only reports data when Web Analytics is enabled on the Vercel project; until then its requests 404 harmlessly. In dev it runs in debug mode and logs to the console instead of sending.
- **The TOC is positioned outside the column.** It sits in the right margin at `xl` and up (`position: absolute; left: 100%`), so it needs the article to be `relative` and the viewport to have room. It is hidden below `xl`.

## Before you finish a change

1. `pnpm build` passes.
2. For UI changes, run `pnpm dev`, load the affected pages, and check the browser console and network panel for errors.
3. New routes export `prerender = true`.
4. No new lockfile other than `pnpm-lock.yaml`.
