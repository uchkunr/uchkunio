# uchkun.io

Personal portfolio and blog. Built with Astro, React, Tailwind CSS v4, and Keystatic CMS. Deployed on Vercel.

## Stack

- **Astro 6** — SSR with static prerendering
- **React** — interactive components
- **Tailwind CSS v4** — styling
- **Keystatic** — local/GitHub-backed CMS for blog and experience
- **Bun** — package manager

## Development

```sh
bun install
bun dev
```

Open [localhost:4321](http://localhost:4321).

## CMS

Content is managed via Keystatic at `/keystatic`. In local mode it writes directly to the filesystem. In production it uses GitHub OAuth — set these env vars:

```
KEYSTATIC_GITHUB_CLIENT_ID=
KEYSTATIC_GITHUB_CLIENT_SECRET=
KEYSTATIC_SECRET=
PUBLIC_KEYSTATIC_GITHUB_APP_SLUG=
```
