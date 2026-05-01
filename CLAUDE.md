# uchkun.io

Personal blog and portfolio for Uchkun Rakhimov. Astro 6 SSR on Vercel. Blog posts are Markdown files in `src/content/blog/` — the admin panel (`/admin`) can also create/edit them via the GitHub API.

## Stack

| Layer | Tool |
|---|---|
| Framework | Astro 6 (SSR, `output: "server"`) |
| UI | React 19, Tailwind CSS v4, shadcn/ui (base-nova) |
| Language | TypeScript strict |
| Package manager | **Bun** (not npm/pnpm) |
| Hosting | Vercel (`@astrojs/vercel` adapter) |
| Auth | HMAC-SHA256 session cookies + Upstash Redis rate limiting |
| Content persistence | GitHub API (`uchkunr/uchkunio` repo, `src/content/blog/`) |
| OG images | Satori + sharp |

## Commands

```bash
bun dev          # dev server → http://localhost:4321
bun build        # production build
bun preview      # preview production build locally
```

## File Map

### Which file to touch for each task

| Task | File(s) |
|---|---|
| **Write / edit a blog post** | `src/content/blog/<slug>.md` |
| **Change frontmatter schema** | `src/content.config.ts` |
| **Site name, description, URL** | `src/config/site.ts` → `SITE` |
| **Nav links** | `src/config/site.ts` → `NAV_LINKS` |
| **Social links** | `src/config/site.ts` → `SOCIAL_LINKS` |
| **Bio text** | `src/config/site.ts` → `BIO` |
| **Projects list** | `src/config/site.ts` → `PROJECTS` |
| **Home page layout** | `src/pages/index.astro` |
| **Blog listing page** | `src/pages/blog/index.astro` |
| **Individual post layout** | `src/pages/blog/[slug].astro` |
| **Tag page** | `src/pages/blog/tags/[tag].astro` |
| **OG image template** | `src/pages/og/[slug].png.ts` |
| **RSS feed** | `src/pages/rss.xml.ts` |
| **Global layout / nav / footer** | `src/layouts/BaseLayout.astro` |
| **Navbar component** | `src/components/Navbar.astro` |
| **Footer component** | `src/components/Footer.astro` |
| **SEO / meta tags** | `src/components/SEOHead.astro` |
| **Global CSS / design tokens** | `src/styles/global.css` |
| **Auth logic** | `src/lib/auth.ts` |
| **Rate limiting** | `src/lib/ratelimit.ts` |
| **Route protection** | `src/middleware.ts` |
| **GitHub API calls** | `src/lib/github.ts` |
| **Admin panel** | `src/pages/admin/` + `src/components/admin/` |
| **Admin API endpoints** | `src/pages/api/admin/` |
| **Reading time util** | `src/lib/reading-time.ts` |
| **Frontmatter parser** | `src/lib/frontmatter.ts` |
| **cn() / class helpers** | `src/lib/utils.ts` |
| **Favicons / public assets** | `public/` |

## Blog Posts

### Location

```
src/content/blog/<slug>.md
```

Slug = filename without `.md`. Used directly as the URL: `/blog/<slug>`.

### Frontmatter schema

```yaml
---
title: "Exact post title shown in hero and <title>"
date: "YYYY-MM-DD"
excerpt: "One or two sentences. Shown in listing, OG image, and meta description."
tags:
  - lowercase-tag
  - another-tag
cover: "https://..." # optional — full-bleed hero image
---
```

All fields except `cover` are **required**. Schema is enforced by `src/content.config.ts` via Zod.

### Slug rules

- Lowercase letters, numbers, hyphens only
- Descriptive, not date-prefixed: `redis-beyond-caching`, not `2026-01-redis`
- Match the post title closely so URL is self-documenting

### Post structure

Start with a `# H1` matching `title`. Use `## H2` and `### H3` for sections — these populate the table of contents (shown when there are >2 headings at depth ≤3).

Code blocks must specify a language for syntax highlighting:

````markdown
```typescript
// code here
```
````

### Content style

- Technical depth over breadth — one concept done properly
- Real code examples, not pseudocode
- Short intros, no preamble about "in today's world..."
- No filler conclusions ("I hope you found this useful")

## Code Conventions

- Path alias `@/*` → `src/*`
- Components: `.astro` for static/layout, `.tsx` for interactive React
- `cn()` from `@/lib/utils` for conditional class merging (clsx + tailwind-merge)
- No CSS modules — Tailwind only
- Icons: `react-icons` for social, custom TSX in `src/components/icons/` for nav
- shadcn/ui components live in `src/components/ui/` — add via `bunx shadcn add <component>`

## Environment Variables

See `.env.example`. Required for admin panel and rate limiting:

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Password for `/admin/login` |
| `ADMIN_SECRET` | Signs session cookies (HMAC key) |
| `GITHUB_TOKEN` | Reads/writes `src/content/blog/` via GitHub API |
| `UPSTASH_REDIS_REST_URL` | Redis for rate limiting |
| `UPSTASH_REDIS_REST_TOKEN` | Redis auth |

## Admin Panel

Route: `/admin` (password-protected, cookie session, 7-day expiry).

The admin panel reads and writes blog posts through the **GitHub API** (not the local filesystem). This means edits made in admin are committed to the repo and trigger a Vercel deploy.

GitHub repo target: `uchkunr/uchkunio`, path: `src/content/blog/<slug>.md`.

Auth flow: `src/middleware.ts` protects `/admin` and `/api/admin` routes. `src/lib/auth.ts` handles token derivation and cookie creation.

## Routing

| Pattern | Type | Notes |
|---|---|---|
| `/` | SSR | Homepage |
| `/blog` | SSR | Post listing with search |
| `/blog/[slug]` | Prerendered | `export const prerender = true` |
| `/blog/tags/[tag]` | Prerendered | Tag filter page |
| `/og/[slug].png` | Prerendered | OG image per post |
| `/rss.xml` | Prerendered | RSS feed |
| `/admin/*` | SSR | Protected by middleware |
| `/api/admin/*` | SSR | API routes, 401 on unauth |
