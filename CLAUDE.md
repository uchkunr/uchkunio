# CLAUDE.md

Guidance for working in this repository. Read it before making changes.

## Project

`uchkun.io` is the personal site and engineering blog of Uchkun Rakhimov, a backend engineer. It is an Astro 7 site deployed to Vercel. Content is Markdown in the repo. There is no database, no auth, no runtime API, and no required environment variables.

| Layer | Choice |
| --- | --- |
| Framework | Astro 7 (`output: "server"`, every route prerendered) |
| UI | React 19 islands, Tailwind CSS v4, shadcn/ui (`base-nova` style on Base UI) |
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
| `/` | `src/pages/index.astro` | Bio and contact, Person and WebSite JSON-LD |
| `/blog` | `src/pages/blog/index.astro` | Post list with client-side search (`?search=` supported) |
| `/blog/[slug]` | `src/pages/blog/[slug].astro` | Post page: hero, TOC, reading progress, code copy buttons, prev/next |
| `/blog/tags/[tag]` | `src/pages/blog/tags/[tag].astro` | Posts filtered by tag |
| `/og/[slug].png` | `src/pages/og/[slug].png.ts` | 1200x630 OG image per post |
| `/rss.xml` | `src/pages/rss.xml.ts` | RSS feed |
| `/404` | `src/pages/404.astro` | Not found page |
| `/sitemap-index.xml` | `@astrojs/sitemap` | Generated at build, not available in dev |

**Client runtime.** `BaseLayout.astro` mounts `<ClientRouter />` (View Transitions). This changes how scripts behave:

- `is:inline` scripts run on the initial load only. Anything that binds DOM listeners must also re-run on `astro:after-swap`. Follow the existing pattern in `BaseLayout.astro` and `blog/index.astro`: wrap setup in an `init` function, call it once, and register it on `astro:after-swap`.
- Re-running setup must be idempotent. The layout replaces nodes with clones before binding and swaps out the global scroll handler to avoid stacking listeners. Do the same for new behavior.
- Theme is a `dark` class on `<html>`, persisted in `localStorage.theme`, applied in `<head>` before paint to avoid a flash.

## Where things live

| Task | File |
| --- | --- |
| Site name, description, URL, OG default, Twitter handle | `src/config/site.ts` (`SITE`) |
| Footer social links, JSON-LD `sameAs` | `src/config/site.ts` (`SOCIAL_LINKS`) |
| Home page copy | `src/pages/index.astro` (bio paragraphs are inline) |
| Blog post | `src/content/blog/<slug>.md` |
| Frontmatter schema | `src/content.config.ts` |
| Global layout, theme, View Transitions, scroll behavior | `src/layouts/BaseLayout.astro` |
| Header and footer | `src/components/Navbar.astro`, `src/components/Footer.astro` |
| Meta, Open Graph, Twitter tags | `src/components/SEOHead.astro` |
| Breadcrumb JSON-LD | `src/components/Breadcrumbs.astro` |
| Vercel Web Analytics loader | `src/components/Analytics.astro` (production only) |
| Icons | `src/components/icons/NavIcons.tsx`, `SocialIcons.tsx` (Tabler set from `react-icons/tb`) |
| shadcn/ui primitives | `src/components/ui/` |
| Design tokens, prose and code block styles | `src/styles/global.css` |
| OG image template | `src/pages/og/[slug].png.ts` |
| Utilities | `src/lib/utils.ts` (`cn`), `src/lib/reading-time.ts` |
| Static assets, favicons, search engine verification files | `public/` |

Nav links are written directly in `Navbar.astro`, and the floating theme and scroll-to-top buttons in `FloatingControls.astro`. Their behavior is bound in `BaseLayout.astro`.

Keep `site.ts`, the icon modules, and `src/components/` free of dead exports. Delete code when its last caller goes away instead of keeping it for later. The exception is `src/components/ui/`: keep each shadcn file whole as generated, and delete the file only when no part of it is used.

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

Writing style for posts and docs:

- One concept in depth over a broad survey. Real, runnable code over pseudocode.
- Get to the point. No throat-clearing intros, no filler conclusions.
- Do not use em dashes (U+2014) or en dashes (U+2013). Use a colon, comma, parentheses, or a new sentence.

## Code conventions

- Path alias `@/*` maps to `src/*`. Use it instead of relative paths across directories.
- `.astro` for static markup and layout. `.tsx` only when a component needs client-side interactivity.
- Tailwind only. No CSS modules, no inline `<style>` blocks for component styling. Shared prose and code styles live in `global.css`.
- Merge conditional classes with `cn()` from `@/lib/utils`.
- Add shadcn components with `pnpm shadcn add <component>`. They land in `src/components/ui/` and use Base UI, not Radix.
- Match the surrounding code. `is:inline` scripts are not bundled or transpiled, and the existing ones use ES5-style `var` and `function`. Keep new inline scripts in the same style.
- Commits follow Conventional Commits as used in history: `feat:`, `fix:`, `refactor:`, `docs:`, `content:`, `chore(deps):`.

## Dependencies

- Use pnpm for every install and removal. Never create `package-lock.json`, `yarn.lock`, or `bun.lock`.
- `dependencies` holds anything imported by site code or used by Astro at runtime, including Astro integrations, the Vercel adapter, and the OG image stack (`satori`, `satori-html`, `sharp`).
- `devDependencies` holds build-only tooling and types: Tailwind and its Vite plugin, `tw-animate-css`, the `shadcn` CLI, and `@types/*`.
- Do not add `@types/*` packages for libraries that ship their own types.
- Do not downgrade packages to fix a problem. Find the root cause and fix it in config or code.
- `pnpm-workspace.yaml` holds pnpm supply-chain settings: `allowBuilds` (packages allowed to run install scripts) and `minimumReleaseAgeExclude` (pinned exceptions to the minimum release age). A new package with an install script or a very recent release may need an entry there.

## Known gotchas

- **Vite dep optimization and View Transitions.** `astro.config.mjs` pre-bundles the `astro/virtual-modules/transitions-*` modules via `vite.optimizeDeps.include`. Without it, Vite discovers them on first load, re-optimizes, and the dev toolbar gets stuck on a 504 "Outdated Optimize Dep" with Astro 7.3 and Vite 8.3. Keep this until a newer Astro or Vite release fixes it, and verify by loading a page and checking that no request returns 504.
- **OG images need network at build time.** The font is fetched from Google Fonts. If that fails, the endpoint falls back to a system font, and the build fails only if none is found.
- **Analytics** loads `/_vercel/insights/script.js` in production builds only. It requires Web Analytics to be enabled on the Vercel project.
- **Icons are hydrated.** `NavIcons` and `SocialIcons` are used with `client:load` even though they are static SVG. New static icons do not need a client directive.

## Before you finish a change

1. `pnpm build` passes.
2. For UI changes, run `pnpm dev`, load the affected pages, and check the browser console and network panel for errors.
3. New routes export `prerender = true`.
4. No new lockfile other than `pnpm-lock.yaml`.
