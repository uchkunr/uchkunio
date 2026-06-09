---
title: "OAuth Token Refresh That Doesn't Break at 3am"
date: "2026-06-07"
excerpt: "Stale-while-revalidate, distributed lock on refresh, and a clean error taxonomy — the patterns that make Gmail and third-party OAuth tokens reliable in production."
tags:
  - oauth
  - typescript
  - production
---

# OAuth Token Refresh That Doesn't Break at 3am

Access tokens expire. Refresh tokens expire too. When your app integrates Gmail or any OAuth provider at scale, the naive refresh logic eventually causes an incident:

- Token expires under load → 50 concurrent requests all try to refresh → you hit the OAuth provider's rate limit → all 50 fail.
- A refresh token gets silently revoked → every request fails with a cryptic error until someone re-authorizes.

Here are the patterns that make this reliable.

## The Thundering Herd Problem

Token expires at 14:30:00. At 14:30:01, 50 requests arrive simultaneously. Each one checks: "is the token expired?" Yes. Each one calls the refresh endpoint. You've just sent 50 parallel refresh requests for the same user. Google will reject most of them.

The fix is a distributed lock on refresh — only one process refreshes, the rest wait and use the result.

```typescript
async function getAccessToken(userId: string): Promise<string> {
  // 1. Check Redis cache with a proactive refresh buffer
  const cached = await tokenCache.get(userId);
  if (cached && !isExpiringSoon(cached, 10 * 60)) {
    return cached.accessToken;
  }

  // 2. Token is missing or expiring in < 10 min — refresh, but only once
  const lockKey = `token:refresh:lock:${userId}`;
  const lock = await tryAcquireLock(redis, lockKey, 60_000);

  if (!lock) {
    // Another process is refreshing — wait briefly and return stale token
    await sleep(500);
    const stale = await tokenCache.get(userId);
    if (stale) return stale.accessToken;
    throw new Error('Token unavailable, retry in a moment');
  }

  try {
    // Re-check after acquiring lock — another process may have refreshed
    const fresh = await tokenCache.get(userId);
    if (fresh && !isExpiringSoon(fresh, 10 * 60)) return fresh.accessToken;

    return await refreshAndCache(userId);
  } finally {
    await lock.release();
  }
}
```

The double-check after acquiring the lock is not optional. The window between "cache miss" and "lock acquired" is exactly where the other process completed its refresh.

## Stale-While-Revalidate for Tokens

For non-critical paths (sending a notification, not blocking a user request), you can return the stale token immediately and refresh in the background:

```typescript
async function getTokenWithBackgroundRefresh(userId: string): Promise<string> {
  const cached = await tokenCache.get(userId);

  if (!cached) {
    return refreshAndCache(userId); // blocking — no choice
  }

  if (isExpiringSoon(cached, 10 * 60)) {
    // Return stale, refresh async — don't await
    refreshAndCache(userId).catch((err) =>
      logger.warn({ userId, err }, 'background token refresh failed')
    );
  }

  return cached.accessToken;
}
```

This eliminates refresh latency from the hot path. The token is at most slightly stale, which is fine — the actual expiry is still 10 minutes away.

## Multi-Layer Storage

Tokens live in two places: Redis for fast access, Postgres for durability. The load path is Redis → Postgres:

```typescript
async function loadToken(userId: string): Promise<TokenData | null> {
  // L1: Redis (sub-millisecond)
  const cached = await redis.get(`token:gmail:${userId}`);
  if (cached) return JSON.parse(cached) as TokenData;

  // L2: Postgres (encrypted at rest)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { googleData: true },
  });
  if (!user?.googleData) return null;

  const token = decrypt(user.googleData) as TokenData;

  // Warm the cache
  const ttl = Math.max(0, token.expiresAt - Date.now() / 1000 - 60);
  await redis.set(`token:gmail:${userId}`, JSON.stringify(token), 'EX', ttl);

  return token;
}

async function saveToken(userId: string, token: TokenData): Promise<void> {
  await Promise.all([
    prisma.user.update({
      where: { id: userId },
      data: { googleData: encrypt(JSON.stringify(token)) },
    }),
    redis.set(
      `token:gmail:${userId}`,
      JSON.stringify(token),
      'EX',
      Math.max(0, token.expiresAt - Date.now() / 1000 - 60)
    ),
  ]);
}
```

Encrypt tokens at rest — they're equivalent to passwords.

## The Error Taxonomy

Not all token errors are the same. Treating them the same is how you end up logging useless "token refresh failed" messages with no path to recovery.

```typescript
async function refreshToken(userId: string, refreshToken: string): Promise<TokenData> {
  try {
    const response = await oauthClient.refreshAccessToken(refreshToken);

    // Google doesn't always return a new refresh token — preserve the old one
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? refreshToken,
      expiresAt: Date.now() / 1000 + response.expires_in,
    };
  } catch (err) {
    const error = err as OAuthError;

    if (isInvalidGrant(error)) {
      // Refresh token revoked or expired — user must re-authorize
      await clearToken(userId);
      throw new TokenRevokedError(userId);
    }

    if (isInsufficientScopes(error)) {
      // User authorized with old scopes, new ones required
      await clearToken(userId);
      throw new InsufficientScopesError(userId);
    }

    if (error.status === 429) {
      const retryAfter = extractRetryAfter(error) ?? 60;
      throw new RateLimitError(retryAfter);
    }

    // Transient error — throw and let the caller retry
    throw err;
  }
}

function isInvalidGrant(err: OAuthError): boolean {
  return (
    err.message?.includes('invalid_grant') ||
    err.message?.includes('Token has been expired or revoked')
  );
}

function extractRetryAfter(err: OAuthError): number | null {
  const fromHeader = err.response?.headers?.['retry-after'];
  if (fromHeader) return parseInt(fromHeader);

  const match = err.message?.match(/Retry-After:\s*(\d+)/);
  return match ? parseInt(match[1]) : null;
}
```

Three distinct failure modes, three distinct recovery paths:

| Error | Cause | Recovery |
|---|---|---|
| `invalid_grant` | Refresh token revoked | Clear token, prompt re-auth |
| Insufficient scopes | App requested new permissions | Clear token, prompt re-auth with new scope |
| 429 | Rate limit hit | Wait `Retry-After` seconds, retry |
| Other | Transient | Retry with backoff |

## Circuit Breaker for the OAuth Provider

If the OAuth endpoint starts failing (5xx, timeouts), you don't want every token request to hammer it. A simple circuit breaker:

```typescript
class TokenCircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private readonly threshold = 5;
  private readonly cooldown = 60_000;

  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  recordSuccess(): void {
    this.failures = 0;
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.openUntil = Date.now() + this.cooldown;
      logger.warn('Token refresh circuit breaker opened');
    }
  }
}
```

When the circuit is open, return the stale token and skip the refresh attempt entirely. A slightly stale token is better than failing every request until the provider recovers.

## Proactive Refresh on Startup

Don't wait for a request to discover an expired token. On app start, scan for tokens expiring within the next hour and refresh them proactively:

```typescript
async function warmTokens(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { googleData: { not: null }, isActive: true },
    select: { id: true, googleData: true },
  });

  await Promise.allSettled(
    users.map(async (user) => {
      const token = decrypt(user.googleData!) as TokenData;
      if (isExpiringSoon(token, 60 * 60)) {
        await refreshAndCache(user.id).catch(() => {
          // Log but don't fail startup
        });
      }
    })
  );
}
```

`Promise.allSettled` instead of `Promise.all` — one bad token doesn't abort the entire warmup.

## What Bites You in Production

**Refresh token not returned on every refresh.** Google only returns a new refresh token if you include `prompt=consent` in the authorization URL. On a standard refresh call, you get only the new access token. Always preserve the existing refresh token when the response doesn't include one.

**Clock skew.** If your server clock drifts, `isExpiringSoon` checks become unreliable. Use UTC everywhere, and add a 60-second buffer on top of your proactive window.

**Multiple app instances.** Each instance has its own in-process state. Use Redis for the circuit breaker state and lock coordination — don't rely on local memory.
