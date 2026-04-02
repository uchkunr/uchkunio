---
title: "API Rate Limiting Done Right: Algorithms and Implementation"
date: "2026-01-30"
excerpt: "Rate limiting protects your API from abuse. Here's how the major algorithms work and which one to pick for your use case."
tags:
  - api
  - backend
  - architecture
---

# API Rate Limiting Done Right: Algorithms and Implementation

Every production API needs rate limiting. Without it, a single bad actor — or a misconfigured client — can bring your service down. But not all rate limiting is equal.

## Why Rate Limit?

1. **Prevent abuse** — stop DDoS and scraping
2. **Fair usage** — ensure no single user monopolizes resources
3. **Cost control** — downstream services (databases, third-party APIs) have limits too
4. **Stability** — protect against traffic spikes

## Algorithm 1: Fixed Window

The simplest approach. Count requests per fixed time window (e.g., per minute).

```typescript
async function fixedWindow(
  key: string,
  limit: number,
  windowMs: number,
  redis: Redis
): Promise<boolean> {
  const window = Math.floor(Date.now() / windowMs);
  const redisKey = `rl:${key}:${window}`;

  const count = await redis.incr(redisKey);
  if (count === 1) {
    await redis.pexpire(redisKey, windowMs);
  }

  return count <= limit;
}
```

**Problem:** Burst at window boundaries. If the limit is 100/minute, a user can send 100 requests at 0:59 and 100 more at 1:00 — 200 requests in 2 seconds.

## Algorithm 2: Sliding Window Log

Track the timestamp of every request:

```typescript
async function slidingWindowLog(
  key: string,
  limit: number,
  windowMs: number,
  redis: Redis
): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const redisKey = `rl:${key}`;

  await redis
    .multi()
    .zremrangebyscore(redisKey, 0, windowStart) // Remove old entries
    .zadd(redisKey, now, `${now}:${Math.random()}`) // Add current
    .zcard(redisKey) // Count
    .pexpire(redisKey, windowMs)
    .exec();

  const count = /* result of zcard */;
  return count <= limit;
}
```

**Accurate** but **memory-heavy** — stores every request timestamp.

## Algorithm 3: Sliding Window Counter

The sweet spot. Combines fixed window efficiency with sliding window accuracy:

```typescript
async function slidingWindowCounter(
  key: string,
  limit: number,
  windowMs: number,
  redis: Redis
): Promise<boolean> {
  const now = Date.now();
  const currentWindow = Math.floor(now / windowMs);
  const previousWindow = currentWindow - 1;
  const elapsed = (now % windowMs) / windowMs; // 0.0 to 1.0

  const [currentCount, previousCount] = await Promise.all([
    redis.get(`rl:${key}:${currentWindow}`).then(Number),
    redis.get(`rl:${key}:${previousWindow}`).then(Number),
  ]);

  // Weighted count
  const estimatedCount =
    previousCount * (1 - elapsed) + currentCount;

  if (estimatedCount >= limit) return false;

  await redis.incr(`rl:${key}:${currentWindow}`);
  await redis.pexpire(`rl:${key}:${currentWindow}`, windowMs * 2);

  return true;
}
```

Low memory, no boundary bursts, good enough accuracy for most APIs.

## Algorithm 4: Token Bucket

Best for allowing controlled bursts:

```typescript
async function tokenBucket(
  key: string,
  capacity: number,     // Max burst size
  refillRate: number,   // Tokens per second
  redis: Redis
): Promise<boolean> {
  const now = Date.now();
  const redisKey = `rl:${key}`;

  const data = await redis.hgetall(redisKey);
  let tokens = parseFloat(data.tokens ?? capacity.toString());
  let lastRefill = parseInt(data.lastRefill ?? now.toString());

  // Add tokens based on elapsed time
  const elapsed = (now - lastRefill) / 1000;
  tokens = Math.min(capacity, tokens + elapsed * refillRate);

  if (tokens < 1) return false;

  tokens -= 1;

  await redis.hset(redisKey, {
    tokens: tokens.toString(),
    lastRefill: now.toString(),
  });
  await redis.pexpire(redisKey, (capacity / refillRate) * 1000 + 1000);

  return true;
}
```

**Use token bucket when:** you want to allow bursts up to a maximum, then throttle to a steady rate.

## Which Algorithm to Pick

| Algorithm | Accuracy | Memory | Burst Protection | Complexity |
|-----------|----------|--------|-------------------|------------|
| Fixed Window | Low | Very Low | ❌ | Simple |
| Sliding Log | High | High | ✅ | Medium |
| Sliding Counter | Good | Low | ✅ | Medium |
| Token Bucket | Good | Low | Controlled | Medium |

**Default choice:** Sliding Window Counter. It's the best balance of accuracy, memory, and simplicity.

## HTTP Headers

Always return rate limit info in headers:

```typescript
res.set({
  "X-RateLimit-Limit": limit.toString(),
  "X-RateLimit-Remaining": Math.max(0, remaining).toString(),
  "X-RateLimit-Reset": resetTime.toString(),
  "Retry-After": retryAfter.toString(), // Only on 429
});

if (!allowed) {
  return res.status(429).json({
    error: "Too Many Requests",
    retryAfter: retryAfterSeconds,
  });
}
```

## Multi-Tier Rate Limiting

Production APIs often need multiple layers:

```typescript
const rateLimiters = [
  { key: (req) => req.ip, limit: 1000, window: "1m" },          // Per IP
  { key: (req) => req.user?.id, limit: 100, window: "1m" },     // Per user
  { key: (req) => `${req.user?.id}:${req.path}`, limit: 20, window: "1m" }, // Per endpoint
];
```

The tightest limit wins. This prevents both global abuse and targeted endpoint hammering.
