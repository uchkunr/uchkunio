---
title: "Docker Multi-Stage Builds: From 1.2GB to 80MB"
date: "2026-03-01"
excerpt: "A real walkthrough of shrinking a Node.js Docker image from 1.2GB to 80MB using multi-stage builds, layer caching, distroless bases, and a production-ready Dockerfile template."
tags:
  - docker
  - devops
---

# Docker Multi-Stage Builds: From 1.2GB to 80MB

I once deployed a Node.js API where each container pulled a 1.2GB image. With 12 replicas across 3 environments, every deploy was downloading 43GB of data. Deploys took 8 minutes just for the image pull. Cold starts in Kubernetes were painful. Here's the step-by-step journey of getting that image down to 80MB.

## The Starting Point: The Naive Dockerfile

This is what most tutorials give you, and what most production apps still run:

```dockerfile
FROM node:20
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

Let's check the size:

```bash
docker build -t myapp:naive .
docker images myapp:naive
# REPOSITORY   TAG     SIZE
# myapp        naive   1.2GB
```

1.2GB. That includes the full Node.js runtime, npm, yarn, Python (for node-gyp), build tools, your source code, devDependencies, test files, and the .git directory. Your production container has `jest`, `eslint`, `prettier`, and every dev tool you've ever installed.

## Step 1: Use a Slim Base Image

The `node:20` image is based on Debian with a full Linux userland. `node:20-slim` drops the extras.

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

```bash
# node:20      -> 1100MB base
# node:20-slim -> 220MB base
```

We're at ~500MB now. Better, but still includes devDependencies and source code in the final image.

## Step 2: Multi-Stage Build

This is the key technique. You use one stage to build, another to run. Only the final stage becomes your image.

```dockerfile
# Stage 1: Build
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Production
FROM node:20-slim AS production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

The builder stage has all devDependencies and source code. The production stage only has production dependencies and compiled output. The builder stage is discarded from the final image.

```bash
docker images myapp:multistage
# SIZE: 280MB
```

Down from 1.2GB to 280MB. But we can go further.

## Step 3: Optimize Layer Caching

Docker caches layers. If a layer hasn't changed, it's reused. The order of your `COPY` commands matters enormously.

```dockerfile
# BAD: any source change invalidates npm install cache
COPY . .
RUN npm ci

# GOOD: only package.json changes invalidate npm install cache
COPY package*.json ./
RUN npm ci
COPY . .
```

This means `npm ci` is cached unless `package.json` or `package-lock.json` changes. Source code changes only rebuild from the `COPY . .` step. This cuts rebuild times from 2 minutes to 5 seconds for code-only changes.

## Step 4: The .dockerignore File

Without `.dockerignore`, `COPY . .` sends everything to the Docker daemon, including `node_modules`, `.git`, test files, and local env files.

```
# .dockerignore
node_modules
.git
*.md
.env*
coverage
tests
__tests__
*.test.ts
*.spec.ts
```

This alone can cut build context from 500MB to 5MB.

## Step 5: Alpine Base

Alpine Linux is a minimal distribution (~5MB). Node.js on Alpine is much smaller:

Same multi-stage pattern, but swap `node:20-slim` for `node:20-alpine`. Add `dumb-init` for proper signal handling (`SIGTERM` forwarding for graceful shutdown) and always run as `USER node`. Image drops to **140MB**.

Caveat: Alpine uses `musl` instead of `glibc`. Some native modules won't compile. If you hit segfaults or "invalid ELF header" errors, this is why.

## Step 6: Distroless (The Final Boss)

Google's distroless images contain only your application and its runtime dependencies. No shell, no package manager, no `ls`, no `cat`. Nothing an attacker could exploit.

```dockerfile
# Stage 1: Build
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Production dependencies
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Stage 3: Distroless runtime
FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["dist/index.js"]
```

```bash
docker images myapp:distroless
# SIZE: 80MB
```

From 1.2GB to 80MB. That's a 93% reduction. Deploys that took 8 minutes now take 45 seconds.

The tradeoff: you can't `docker exec` into a distroless container and poke around. There's no shell. For debugging, I keep a debug variant:

```dockerfile
# For debugging only, never deploy this
FROM gcr.io/distroless/nodejs20-debian12:debug
```

This adds a `busybox` shell you can exec into.

## The Production Dockerfile Template

Here's the template I start every Node.js project with:

```dockerfile
# syntax=docker/dockerfile:1

# --- Build stage ---
FROM node:20-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# --- Production dependencies ---
FROM node:20-slim AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- Runtime ---
FROM gcr.io/distroless/nodejs20-debian12 AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3000
USER nonroot:nonroot

CMD ["dist/index.js"]
```

## Security Scanning

A smaller image has fewer vulnerabilities simply because there's less software. Always scan with Trivy, Docker Scout, or Snyk in CI. I fail the pipeline on critical or high severity findings.

## Common Gotchas

**Native modules and Alpine**: If you get "invalid ELF header" errors, the module was compiled for glibc but Alpine uses musl. Add `RUN apk add --no-cache python3 make g++` in the builder stage.

**Files owned by root**: Use `COPY --from=builder --chown=node:node /app/dist ./dist` to set correct ownership.

**Healthchecks in distroless**: No `curl` or `wget` exists. Use Kubernetes probes or a Node.js-based healthcheck: `HEALTHCHECK CMD ["node", "-e", "fetch('http://localhost:3000/health').then(r => { if (!r.ok) process.exit(1) })"]`

## Size Comparison Summary

| Approach | Image Size | Build Time | Security |
|----------|-----------|------------|----------|
| `node:20` naive | 1.2GB | 3 min | Poor |
| `node:20-slim` | 500MB | 2.5 min | Fair |
| Multi-stage slim | 280MB | 2 min | Good |
| Multi-stage Alpine | 140MB | 2 min | Good |
| Multi-stage Distroless | 80MB | 2 min | Excellent |

Every step in this progression is a concrete improvement. Start wherever makes sense for your project. But if you're still shipping 1GB+ images to production, carve out an afternoon and follow these steps. Your deploy pipeline, your cloud bill, and your on-call engineers will thank you.
