# AGENTS.md

Guidance for anyone working in this repository, human or agent (Claude Code reads it through `CLAUDE.md`, which imports this file). Read it before making changes. To write a post, follow [Writing a post](#writing-a-post) step by step.

## Project

`uchkun.io` is the personal site and engineering blog of Uchkun Rakhimov, a backend engineer. It is an Astro 7 site deployed to Vercel. Content is Markdown in the repo. There is no database, no auth, no runtime API, and no required environment variables.

| Layer | Choice |
| --- | --- |
| Framework | Astro 7 (`output: "server"`, every route prerendered) |
| UI | Tailwind CSS v4 plus hand-written CSS in `global.css`. No client framework: all interactivity is vanilla TypeScript in Astro `<script>` tags |
| Fonts | Jost (Latin and Cyrillic) via Astro's `fonts` config (Google provider, self-hosted at build). Code uses the system monospace stack |
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
| `/blog` | `src/pages/blog/index.astro` | Posts grouped by year, client-side search (`/` focuses it) and tag filter; both combine and live in the URL (`?q=`, `?tag=`) |
| `/blog/[slug]` | `src/pages/blog/[slug].astro` | Post page (Uzbek original): title moves into the header on scroll, progress line, TOC rail from `md` up, back-to-top button, code copy, prev/next, language menu |
| `/en/blog/[slug]`, `/ru/blog/[slug]` | `src/pages/en/blog/[slug].astro`, `src/pages/ru/blog/[slug].astro` | Translated post page, same `PostLayout`, prev/next within the language |
| `/blog/tags/[tag]` | `src/pages/blog/tags/[tag].astro` | Posts filtered by tag |
| `/og.png` | `src/pages/og.png.ts` | 1200x630 default OG image for every page that isn't a post: avatar, name, role |
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
| Post page markup, `hreflang`, `og:locale:alternate` | `src/layouts/PostLayout.astro` |
| Language menu above a post (O'zbekcha, English, Русский) | `src/components/LanguageMenu.astro` |
| Locales, slugs, post URLs, translations lookup | `src/lib/posts.ts` (`LOCALES`, `localeOf`, `slugOf`, `postUrl`, `getTranslations`) |
| Frontmatter schema | `src/content.config.ts` |
| Fonts | `astro.config.mjs` (`fonts`), loaded with `<Font>` in `BaseLayout.astro` |
| Layout and every client-side behavior | `src/layouts/BaseLayout.astro` |
| Header: nav, theme toggle, reading title, progress line | `src/components/Header.astro` |
| Footer: RSS and source link | `src/components/Footer.astro` |
| Post rows shared by home, blog, and tag pages | `src/components/PostList.astro` |
| Icons | `@lucide/astro` components, inlined as SVG at build time (`stroke-width={1.75}`, `aria-hidden="true"`) |
| Meta, Open Graph, Twitter tags | `src/components/SEOHead.astro` |
| Breadcrumb JSON-LD | `src/components/Breadcrumbs.astro` |
| Vercel Web Analytics | `<Analytics />` from `@vercel/analytics/astro` at the end of `<body>` in `BaseLayout.astro` |
| Design tokens, motion, component and prose styles | `src/styles/global.css` |
| Post loading, sorting, reading time, year grouping | `src/lib/posts.ts` |
| Date formatting | `src/lib/date.ts` |
| OG image templates | `src/pages/og.png.ts` (default), `src/pages/og/[...slug].png.ts` (posts); shared size, palette, font and rendering in `src/lib/og.ts` |
| Static assets, favicons, search engine verification files | `public/` |

Nav links are written directly in `Header.astro`. Keep `site.ts` and `src/components/` free of dead exports: delete code when its last caller goes away instead of keeping it for later.

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
- Every fenced code block declares a language. Shiki highlights with `github-light` and `vesper`.
- Reading time is computed at 230 words per minute from the raw body.
- Changing a slug changes a public URL. Treat it as a breaking change.
- **Translations.** Posts are written in Uzbek; a translation is the same filename under `en/` or `ru/` (`src/content/blog/en/<slug>.md` serves `/en/blog/<slug>`). Frontmatter is identical except `title` and `excerpt`; code blocks stay identical except human-language comments and output text; links to other posts point to the same language. `getPosts()` returns Uzbek posts only, so lists, tags and RSS never mix languages. The site chrome is English and is not translated.
- **i18n routing** is Astro's own (`i18n` in `astro.config.mjs`): locales `uz`, `en`, `ru`, `defaultLocale: "uz"`, `prefixDefaultLocale: false`. Each translated locale has its own folder in `src/pages/` (`en/`, `ru/`), whose name must match the locale code; post URLs come from `getRelativeLocaleUrl()` inside `postUrl()`. `LOCALES` in `src/lib/posts.ts` must stay in sync with the config.
- `<html lang>` and `og:locale` follow the post's language, with `og:locale:alternate` for the other versions; every post page emits `hreflang` alternates with `x-default` pointing at the Uzbek original, and the sitemap (`@astrojs/sitemap` with `i18n`) lists the same pairs.
- **Sketches** live in `public/sketches/` and are generated; see [Sketches](#sketches).
- **Media.** Recordings live in `public/media/`. Convert GIFs over a few hundred KB to MP4 (`ffmpeg ... -c:v libx264 -crf 26 -movflags +faststart`) with a poster JPEG, and embed them as `<video autoplay loop muted playsinline>`; the layout script pauses them and shows controls under reduced motion.
- One font for every language: Jost covers Uzbek (including `oʻ`/`gʻ`), English and Russian, on pages and OG images alike. A replacement must cover Cyrillic too.

Writing style for posts and docs:

- One concept in depth over a broad survey. Real, runnable code over pseudocode.
- Get to the point. No throat-clearing intros, no filler conclusions.
- Do not use em dashes (U+2014) or en dashes (U+2013). Use a colon, comma, parentheses, or a new sentence.

## Writing a post

Posts are written together with the author: the author brings the story, the agent writes it up as a senior writer. Each post has an Uzbek original, English and Russian translations, and only numbers that were measured.

### 1. Start from the author's brief

The author sends a brief in this shape:

```text
role: senior writer
title: Transactional outbox: microservicelar o'rtasida real time chat
description:
Muammo: what had to work, in the author's system (services, tables, broker)
Yechim: what the author did: the first version, how it broke, the fix
```

The brief is the post's skeleton. Continue the author's draft rather than starting a new one:

- Keep the author's story, voice (first person: "men ... qildim") and names: services, schemas, tables, the broker. Write from the brief, not from earlier posts on the site.
- Fix what the draft gets wrong or leaves out: why the first version failed (the mechanism, not just the symptom), edge cases (duplicates, ordering, outages, deploys), and the honest limits of the fix.
- Add real code examples in the author's stack (TypeScript, Node.js, Postgres, and the broker named in the brief): the first version, the fix, and every part a reader needs to run it.
- Do not invent facts about the author's system. When a detail has to be assumed (a library, a table, a component the brief does not mention), make the assumption and list it for the author with the draft.
- One problem, one mechanism, one fix. If a claim cannot be shown with a command and its output, it does not go in.

### 2. Measure before writing

Never invent an output. Reproduce every claim and paste what the machine printed.

- Postgres: a throwaway container, removed afterwards. Limit CPUs when the result depends on them.
  ```bash
  docker run -d --rm --name lab --cpus=2 -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:54397:5432 postgres:18 -c max_connections=250
  docker exec -i lab psql -U postgres -X -c "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON) ..."
  docker stop lab
  ```
- Concurrency (lock queues, races): background `psql` sessions with `sleep` offsets, then `pg_stat_activity` with `pg_blocking_pids(pid)`.
- Benchmarks: run the load generator outside the measured container (`docker run --rm --network container:lab postgres:18 pgbench ...`), repeat until two runs agree, report the stable one.
- Node and Bun behavior: small scripts in a scratch directory, never in this repo. Open-loop load (a request every N ms without waiting) shows tail latency; closed loops hide it.
- Keep the measured numbers next to the draft. Every number in the text, a table, a sketch or an alt text must come from that list.

### 3. Write the Uzbek original

- File: `src/content/blog/<slug>.md`, slug in English (`keyset-pagination`).
- Title: the author's, with only spelling fixed ("microservice'lar", "real-time"). Without one, state the subject and the result plainly: "Keyset pagination: OFFSET'dan 1800 barobar tezroq sahifalash". No teasers, metaphors or questions.
- Excerpt: two sentences, the problem and the measured result.
- Literary, clear Uzbek (Latin, straight apostrophes): full connected sentences ("Shu sababli", "Natijada", "Biroq"), no slang, no fragments. Technical terms stay in English where Uzbek engineers use them (lock, pool, worker, commit).
- Shape: the author's context (Muammo), the first version with its code, how it failed (measured), why, the fix with its code (Yechim), its measurement, then a closing `## Xulosa` section of two to four takeaways (never "Qoidalar"). About 500 to 900 words of prose, five to twelve code blocks.
- Reference post for structure and voice: `src/content/blog/transactional-outbox-realtime-chat.md`. Sections follow the story: the context without a heading, `## Birinchi versiya: ...`, `## Ikkinchi versiya: ...`, a section per part of the fix, `## Natija` with the measured output, `## Xulosa`.
- Outputs go in ```` ```text ```` blocks or as `// [{ t: "string" }]` comments next to the call.
- Be honest about trade-offs and limits of the measurement (CPU limits, slowed-down animations, what was simplified).
- Dates: every post has a distinct date, in the order posts were written, never in the future. Adding a post may mean spreading the existing dates again (same date in all three languages).

### 4. Draw two sketches

One static diagram of the mechanism and one animated sketch of the result (usually `raceChart`). See [Sketches](#sketches). Embed each right after the paragraph or output it illustrates:

```md
![Alt text with the finding and its numbers](/sketches/<post>/<name>.svg)
```

### 5. Translate

`src/content/blog/en/<slug>.md` and `src/content/blog/ru/<slug>.md`, same filename. Two agents in parallel work well; give each these rules:

- Translate `title` and `excerpt`; every other frontmatter field stays byte-identical.
- Code blocks stay identical except human-language comments and output words; aligned columns stay aligned.
- Image paths stay; only alt text is translated. Links to other posts gain the language prefix (`/en/blog/<slug>`).
- Same headings, tables, lists and images in the same places; no fact added or dropped.
- Senior engineering voice, natural in the target language. Russian: established terms (блокировка, пул соединений), «ёлочки», мс and с in prose.
- No em or en dashes, including in Russian where typography would usually want one.

### 6. Verify

```bash
grep -cP '[\x{2013}\x{2014}]' src/content/blog/*.md src/content/blog/*/*.md   # all 0
pnpm build                                                                     # schema, routes, OG images
```

Then open the post in all three languages in a browser: sketches render and animate, dark mode inverts them, the language menu switches between them, and `dist/client/og/ru/<slug>.png` shows Cyrillic.

### 7. Commit

Conventional Commits, split by purpose: `content: add a post on ...` for the Uzbek post with its sketches, `content: add English and Russian translations ...`, `feat:` for site or tooling changes.

## Sketches

Hand-drawn SVG diagrams in the Excalidraw style, generated from code: `scripts/sketches/lib.ts` (rough.js strokes, Excalidraw's Virgil font with glyphs as paths) and `scripts/sketches/build.ts` (one function per sketch).

```bash
pnpm sketches                 # every sketch into public/sketches/<post>/<name>.svg
pnpm sketches keyset          # only names starting with "keyset"
pnpm sketches:preview keyset  # PNG previews in <tmpdir>/sketches-preview, read them before committing
```

A sketch is registered under its output path:

```ts
sketches["keyset/offset-vs-keyset"] = () => {
  const s = new Sketch(860, 320, "Title: the finding with its numbers, used as the SVG <title>");
  s.rect(x, y, w, h, { fill: FILL.gray });                      // hachure fill by default
  s.text("label", cx, baseline, { anchor: "middle", size: 19 });  // y is the baseline
  s.arrow(x1, y1, x2, y2, { stroke: STROKE.red, dashed: true });
  return s.toSVG();
};
```

- `Sketch` methods: `rect`, `ellipse`, `line`, `arrow`, `text`, `group(attrs, draw)`. Shape options: `stroke`, `strokeWidth`, `fill`, `fillStyle` (`"hachure"`, `"solid"`), `roughness`, `dashed`.
- Palette: `FILL.{blue,green,red,yellow,violet,gray}` with matching `STROKE.*`, `INK` for text, `MUTED` for captions. Meaning is consistent: green is the good outcome, red the failure or the slow path, blue and violet are components, yellow is storage or a broker, gray is neutral.
- Canvas 760 to 900 wide. Sketches render at about 0.7 to 0.8 of their size, so text is at least 15 (enforced) and labels are 19 to 22. Estimate text width as 0.5 x size per character and leave room; check every preview for text touching lines or box edges.
- Labels are English technical terms and numbers so one SVG serves all three languages. Put the explanation in the alt text, which is translated.
- Benchmarks: `raceChart(title, subtitle, lanes)`; each lane has `label`, `seconds` (animation length), `value` (final text), `fill`, `stroke`. Real time when it fits in about 4 s; otherwise scale it and say so in the subtitle ("slowed down 25x").
- Other animation: wrap elements in `s.group('class="name"', ...)` and pass CSS to `toSVG(motion, still)`. `during(cls, cycle, from, to)` shows an element from `from` to `to` seconds of each cycle; movement is `@keyframes` with `transform: translate(Xpx, Ypx)` on a group drawn at the origin. `motion` only runs under `prefers-reduced-motion: no-preference`; `still` sets the frame shown otherwise (and in previews), so it must tell the story on its own.
- Never edit `public/sketches/` by hand; change `build.ts` and rerun it. The site inverts sketches in dark mode the way Excalidraw does, so draw for a light background only.

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

- **One URL per page.** `trailingSlash: "never"`: internal links, hreflang, canonical, RSS and the sitemap all omit the trailing slash, and Vercel answers `/path/` with a 308 to `/path`. Build new links with `postUrl()` and never append a slash. `SITE.url` must be the domain Vercel serves without a redirect; canonical URLs that redirect slow down indexing.
- **Vite dep optimization and View Transitions.** `astro.config.mjs` pre-bundles the `astro/virtual-modules/transitions-*` modules via `vite.optimizeDeps.include`. Without it, Vite discovers them on first load, re-optimizes, and the dev toolbar gets stuck on a 504 "Outdated Optimize Dep" with Astro 7.3 and Vite 8.3. Keep this until a newer Astro or Vite release fixes it, and verify by loading a page and checking that no request returns 504.
- **The build needs network access.** Astro's Google font provider downloads Jost at build time, and `src/lib/og.ts` fetches it separately for Satori (which needs TTF), plus the GitHub avatar for the default card. The OG cards fall back to a system font and drop the avatar; the font provider has no fallback.
- **Analytics** uses the official `@vercel/analytics/astro` component. It renders a `<vercel-analytics>` custom element, so every client-side navigation swaps in a new one and records a pageview with the route pattern (`/blog/[slug]`), not just the path. Keep it at the end of `<body>`, not in `<head>` as Vercel's docs show: the HTML parser closes `<head>` at the first custom element, which moves the stylesheet and every later head tag into `<body>`. It only reports data when Web Analytics is enabled on the Vercel project; until then its requests 404 harmlessly. In dev it runs in debug mode and logs to the console instead of sending.
- **The TOC is a rail on the right edge.** `position: fixed`, one dash per `h2`/`h3`, visible from `md` up (below that there is no margin for it). Hover, keyboard focus or a tap on the rail opens the full list; the links stay focusable while it is closed (opacity, not `visibility`), so tabbing into one opens it. The active heading is the last one past the upper third of the viewport. The back-to-top button sits in the bottom-right corner and is `inert` until the reader is a screen into the post.

## Before you finish a change

1. `pnpm build` passes.
2. For UI changes, run `pnpm dev`, load the affected pages, and check the browser console and network panel for errors.
3. New routes export `prerender = true`.
4. No new lockfile other than `pnpm-lock.yaml`.
