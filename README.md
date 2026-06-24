# uchkun.io - personal website

![Astro](https://img.shields.io/badge/Astro-v6.0-FF5D01?logo=astro&logoColor=white) ![React](https://img.shields.io/badge/React-v19.0-20232A?logo=react&logoColor=61DAFB) ![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4.0-38B2AC?logo=tailwind-css&logoColor=white) ![Bun](https://img.shields.io/badge/Bun-v1.0-1f2023?logo=bun&logoColor=fbf0e9) ![Redis](https://img.shields.io/badge/Redis-v7.0-CC0000?logo=redis&logoColor=white) ![Vercel](https://img.shields.io/badge/Vercel-v1.0-000000?logo=vercel&logoColor=white)

Personal portfolio website built with Astro, React, and Tailwind CSS. Hosted on Vercel.

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
