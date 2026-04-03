import { Redis } from "@upstash/redis";

const MAX_ATTEMPTS = 3;
const BLOCK_TTL = 60 * 60 * 24 * 7; // 1 week (seconds)
const WINDOW_TTL = 60 * 60; // 1 hour attempt window

function getRedis(): Redis | null {
  const url = import.meta.env.UPSTASH_REDIS_REST_URL;
  const token = import.meta.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function isBlocked(ip: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const blocked = await redis.get(`admin:blocked:${ip}`);
  return blocked !== null;
}

export async function recordFailure(ip: string): Promise<{ blocked: boolean; attemptsLeft: number }> {
  const redis = getRedis();
  if (!redis) return { blocked: false, attemptsLeft: MAX_ATTEMPTS };

  const attemptsKey = `admin:attempts:${ip}`;
  const blockKey = `admin:blocked:${ip}`;

  const attempts = await redis.incr(attemptsKey);

  // Set expiry on first attempt
  if (attempts === 1) {
    await redis.expire(attemptsKey, WINDOW_TTL);
  }

  if (attempts >= MAX_ATTEMPTS) {
    await redis.set(blockKey, Date.now(), { ex: BLOCK_TTL });
    await redis.del(attemptsKey);
    return { blocked: true, attemptsLeft: 0 };
  }

  return { blocked: false, attemptsLeft: MAX_ATTEMPTS - attempts };
}

export async function clearRecord(ip: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(`admin:attempts:${ip}`);
  await redis.del(`admin:blocked:${ip}`);
}
