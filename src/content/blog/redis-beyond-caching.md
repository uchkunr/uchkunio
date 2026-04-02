---
title: "Redis Beyond Caching: Queues, Pub/Sub, and Rate Limiters"
date: "2025-12-15"
excerpt: "Redis is not just a cache. I've used it as a message queue, a rate limiter, a leaderboard engine, and a real-time event bus. Here's how, and when to stop."
tags:
  - redis
  - backend
  - architecture
---

# Redis Beyond Caching: Queues, Pub/Sub, and Rate Limiters

Every tutorial introduces Redis as a cache. Set a key, get a key, set a TTL. That's maybe 20% of what Redis does in a real production system. I've run Redis in production for six years, and caching is often the least interesting thing it handles.

## Redis as a Message Queue

Before you reach for RabbitMQ or SQS, consider whether Redis covers your use case. For simple job queues with moderate durability requirements, it often does.

The basic pattern uses `RPUSH` to enqueue and `BLPOP` to dequeue:

```javascript
const Redis = require('ioredis');
const redis = new Redis();

// Producer
async function enqueueJob(queue, job) {
  await redis.rpush(queue, JSON.stringify({
    id: crypto.randomUUID(),
    payload: job,
    createdAt: Date.now(),
  }));
}

// Consumer - BLPOP blocks until a message arrives (timeout 0 = wait forever)
async function processJobs(queue) {
  while (true) {
    const result = await redis.blpop(queue, 0);
    const job = JSON.parse(result[1]);
    try {
      await handleJob(job);
    } catch (err) {
      // Push failed jobs to a dead-letter queue
      await redis.rpush(`${queue}:failed`, JSON.stringify({
        ...job,
        error: err.message,
        failedAt: Date.now(),
      }));
    }
  }
}
```

The problem with `BLPOP` is that if your worker crashes after popping the message but before processing it, the message is gone. This is where `BRPOPLPUSH` (now `BLMOVE` in Redis 6.2+) saves you:

```javascript
async function processJobsSafe(source) {
  const processing = `${source}:processing`;

  while (true) {
    // Atomically pops from source and pushes to processing list
    const raw = await redis.brpoplpush(source, processing, 0);
    const job = JSON.parse(raw);

    try {
      await handleJob(job);
      // Only remove from processing after successful handling
      await redis.lrem(processing, 1, raw);
    } catch (err) {
      await redis.lrem(processing, 1, raw);
      await redis.rpush(`${source}:failed`, raw);
    }
  }
}
```

Now if your worker crashes, the message stays in the `processing` list. A separate recovery process can inspect that list and re-enqueue stale items.

## Pub/Sub for Real-Time Events

Redis Pub/Sub is fire-and-forget. No persistence, no acknowledgment. If nobody is listening when a message is published, it vanishes. This is a feature, not a bug.

I use it for things like cache invalidation across multiple app servers:

```javascript
// Publisher (when data changes)
async function invalidateCache(entity, id) {
  await redis.publish('cache:invalidate', JSON.stringify({ entity, id }));
}

// Subscriber (on each app server)
const sub = new Redis();
sub.subscribe('cache:invalidate');

sub.on('message', (channel, message) => {
  const { entity, id } = JSON.parse(message);
  localCache.delete(`${entity}:${id}`);
});
```

The critical thing: your subscriber Redis connection is dedicated. Once you call `subscribe`, that connection can only run subscribe commands. Always use a separate connection for pub/sub.

## Sorted Sets for Leaderboards and Rate Limiting

Sorted sets are Redis's secret weapon. Every member has a score, and Redis keeps them ordered. Operations on sorted sets are O(log n).

### Leaderboard in 10 Lines

```javascript
async function updateScore(userId, points) {
  await redis.zincrby('leaderboard', points, userId);
}

async function getTopPlayers(count = 10) {
  // ZREVRANGE returns highest scores first
  return redis.zrevrange('leaderboard', 0, count - 1, 'WITHSCORES');
}

async function getPlayerRank(userId) {
  // 0-indexed, null if not in set
  const rank = await redis.zrevrank('leaderboard', userId);
  return rank !== null ? rank + 1 : null;
}
```

### Sliding Window Rate Limiter

This is my favorite Redis pattern. Most rate limiter tutorials use the simple counter approach (INCR + EXPIRE), but that has a boundary problem: a user can make 100 requests at 11:59:59 and another 100 at 12:00:01, effectively doubling the limit.

Sliding window with sorted sets fixes this:

```javascript
async function isRateLimited(userId, limit, windowSec) {
  const key = `ratelimit:${userId}`;
  const now = Date.now();
  const windowStart = now - windowSec * 1000;

  const pipeline = redis.pipeline();
  // Remove entries outside the window
  pipeline.zremrangebyscore(key, 0, windowStart);
  // Count entries in the window
  pipeline.zcard(key);
  // Add current request (score = timestamp, member must be unique)
  pipeline.zadd(key, now, `${now}:${crypto.randomUUID()}`);
  // Set expiry on the whole key so it self-cleans
  pipeline.expire(key, windowSec);

  const results = await pipeline.exec();
  const currentCount = results[1][1];

  return currentCount >= limit;
}
```

The pipeline is important. Without it, you have four round trips to Redis. With it, you have one.

## Redis Streams: The Kafka You Already Have

Redis Streams (added in 5.0) give you a persistent, consumer-group-aware log. Think of it as a lightweight Kafka that lives in your Redis instance.

```javascript
// Producer
async function publishEvent(stream, event) {
  // * tells Redis to auto-generate the ID (timestamp-based)
  await redis.xadd(stream, '*', 'type', event.type, 'data', JSON.stringify(event.data));
}

// Create a consumer group (do this once, at startup)
async function setupConsumerGroup(stream, group) {
  try {
    await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
  } catch (err) {
    // BUSYGROUP means the group already exists, which is fine
    if (!err.message.includes('BUSYGROUP')) throw err;
  }
}

// Consumer
async function consumeEvents(stream, group, consumer) {
  while (true) {
    const results = await redis.xreadgroup(
      'GROUP', group, consumer,
      'COUNT', 10,
      'BLOCK', 5000,  // Block for 5s if no new messages
      'STREAMS', stream, '>'  // > means "only new messages"
    );

    if (!results) continue;

    for (const [, messages] of results) {
      for (const [id, fields] of messages) {
        await processEvent(fields);
        await redis.xack(stream, group, id);
      }
    }
  }
}
```

Streams give you what Pub/Sub does not: persistence, consumer groups, acknowledgment, and the ability to replay history. If you need "at least once" delivery, use Streams. If you need "fire and forget" notifications, use Pub/Sub.

## When NOT to Use Redis

I have learned every one of these the hard way:

**Don't use Redis as your primary database.** Yes, it has persistence (RDB snapshots, AOF log). No, that does not make it a database. I watched a team lose 30 minutes of order data because their Redis instance ran out of memory and started evicting keys with the `allkeys-lru` policy. Their orders were the least-recently-used keys.

**Don't store large blobs.** Redis is single-threaded. A 50MB value blocks the event loop for everyone. If you need to cache large objects, put them in S3 and cache the URL in Redis.

**Don't use Pub/Sub for critical messages.** No subscriber online? Message gone. Subscriber crashes mid-processing? Message gone. Use Streams or a proper message broker for anything that cannot be lost.

**Don't skip memory planning.** Redis keeps everything in RAM. Calculate your expected dataset size. A Redis instance with `maxmemory` set to 1GB that hits that limit will either reject writes (`noeviction`) or start deleting keys you might need. Neither is fun at 3 AM.

```bash
# Check memory usage in production
redis-cli info memory | grep used_memory_human
redis-cli info memory | grep maxmemory_human

# See which keys are eating memory
redis-cli --bigkeys
```

## My Production Redis Checklist

After years of incidents, I start every Redis deployment with this:

1. Set `maxmemory` and choose an eviction policy deliberately
2. Enable `slowlog` with a threshold of 10ms
3. Use key prefixes and namespaces (`app:user:123`, not just `123`)
4. Set TTLs on everything that is not permanent
5. Use connection pooling (ioredis does this by default)
6. Monitor with `INFO` stats, not just ping

Redis is a Swiss Army knife. The trick is knowing which blade to use and when to put the knife down entirely.
