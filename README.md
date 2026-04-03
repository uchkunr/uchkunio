# uchkun.io

Personal portfolio and blog. Built with Astro, React, Tailwind CSS v4. Deployed on Vercel.

## Stack

- **Astro 6** — SSR with static prerendering
- **React** — interactive components
- **Tailwind CSS v4** — styling
- **Bun** — package manager

## Development

```sh
bun install
bun dev
```

Open [localhost:4321](http://localhost:4321).

## Admin

Custom admin panel at `/admin`. Password-protected, writes content to GitHub via API.

```sh
cp .env.example .env
# fill in the values
```

| Variable | Description |
|---|---|
| `ADMIN_PASSWORD` | Login password |
| `ADMIN_SECRET` | Random secret for session signing (`openssl rand -hex 32`) |
| `GITHUB_TOKEN` | Personal access token with `repo` scope |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis URL (free tier) |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis token |

Upstash: [upstash.com](https://upstash.com) → Create Database → REST API.

### Security model

- All `/admin` and `/api/admin` routes are protected by middleware
- Session token is HMAC-SHA256 derived from `ADMIN_SECRET` — changing the secret invalidates all sessions
- Password and token comparisons use constant-time equality to prevent timing attacks
- Failed logins have a fixed 500ms delay to slow brute force
- **3 failed attempts = IP blocked for 7 days** (via Upstash Redis)
- Cookies are `HttpOnly`, `SameSite=Strict`, `Secure` (in production)
- Slug inputs are sanitized (`[^a-z0-9-]` stripped) to prevent path traversal

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
