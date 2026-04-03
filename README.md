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

## Contributing

This is a personal portfolio. PRs are not accepted for content changes (blog posts, bio, experience).

Bug fixes and technical improvements are welcome — open an issue first.

**Before submitting a PR:**

- `bun dev` runs without errors or warnings
- Code follows the existing style — no new dependencies without discussion
- Commits follow [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `chore:`, etc.
- One concern per PR — no bundling unrelated changes
- Do not leave `console.log`, commented-out code, or TODOs

PRs that ignore these rules will be closed without review.
