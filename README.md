# uchkun.io

Personal site and blog. A single-page bio with a writing section.

## Stack

- **Astro 6** - SSR with static prerendering
- **React 19** - interactive components
- **Tailwind CSS v4** - styling
- **Bun** - package manager
- **Vercel** - hosting

## Development

```sh
bun install
bun dev
```

Open [localhost:4321](http://localhost:4321).

## Structure

- `/` - bio and technical work
- `/blog` - writing
- `/admin` - custom admin panel for publishing posts

## Admin

Password-protected. Writes Markdown posts to GitHub via API.

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
- Session token is HMAC-SHA256 derived from `ADMIN_SECRET` - changing the secret invalidates all sessions
- Password and token comparisons use constant-time equality to prevent timing attacks
- Failed logins have a fixed 500ms delay to slow brute force
- **3 failed attempts = IP blocked for 7 days** (via Upstash Redis)
- Cookies are `HttpOnly`, `SameSite=Strict`, `Secure` (in production)
- Slug inputs are sanitized (`[^a-z0-9-]` stripped) to prevent path traversal

## Contributing

This is a personal site. PRs are not accepted for content changes (blog posts, bio).

Bug fixes and technical improvements are welcome - open an issue first.
