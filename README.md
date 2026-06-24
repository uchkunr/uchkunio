# uchkun.io

Personal portfolio website built with Astro, React, and Tailwind CSS. Hosted on Vercel.

## Stack

- **Framework**: Astro 6 (SSR + hybrid prerendering)
- **UI**: React 19 + Tailwind CSS v4 + Base UI
- **Runtime & PM**: Bun
- **Database**: Upstash Redis (rate limiting & IP blocklists)

## Development

```bash
bun install
bun dev
```

## Configuration

Copy `.env.example` to `.env` and fill in the values:

```ini
ADMIN_PASSWORD=...
ADMIN_SECRET=...             # HMAC signing key (openssl rand -hex 32)
GITHUB_TOKEN=...             # GitHub Personal Access Token (repo scope)
UPSTASH_REDIS_REST_URL=...   # Upstash Redis REST URL
UPSTASH_REDIS_REST_TOKEN=... # Upstash Redis REST Token
```

## License

MIT. Feel free to use the code for your own site.
