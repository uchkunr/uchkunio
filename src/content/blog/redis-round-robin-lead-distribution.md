---
title: "Fair Lead Distribution at Scale with Redis Round-Robin"
date: "2026-06-09"
excerpt: "How to distribute leads fairly across sales agents using atomic Lua scripts, distributed locks, and quota-aware round-robin — without ever double-assigning."
tags:
  - redis
  - distributed-systems
  - typescript
---

# Fair Lead Distribution at Scale with Redis Round-Robin

Assigning incoming leads to sales agents sounds trivial until you hit these constraints simultaneously:

- Multiple workers process the same queue concurrently
- Agents have different quotas (agent A gets 2 leads per turn, agent B gets 1)
- Some sources are exclusive to specific agents
- You need to fan a single lead out to multiple agents without losing data integrity

Here's the architecture we built for a CRM backend, translated to TypeScript.

## The State Problem

Round-robin needs shared mutable state: *who's next, and how many have they gotten this turn?*

Storing this in Postgres means a `SELECT FOR UPDATE` or `REPEATABLE READ` transaction on every assignment. Under load, that's contention. Instead, keep it in Redis and use a Lua script to make the transition atomic — no locks, no retries.

```typescript
interface RoundRobinState {
  currentIndex: number;  // which user is next
  currentQuota: number;  // how many leads they've received this turn
}

const ROUND_ROBIN_SCRIPT = `
local key = KEYS[1]
local usersCount = tonumber(ARGV[1])
local quota = tonumber(ARGV[2])

local idx = tonumber(redis.call('HGET', key, 'currentIndex')) or 0
local cnt = tonumber(redis.call('HGET', key, 'currentQuota')) or 0

local assignedIndex = idx
cnt = cnt + 1

if cnt >= quota then
  idx = (idx + 1) % usersCount
  cnt = 0
end

redis.call('HMSET', key, 'currentIndex', idx, 'currentQuota', cnt)
redis.call('EXPIRE', key, 604800)

return assignedIndex
`;

async function getNextUserIndex(
  redis: Redis,
  providerId: string,
  users: User[]
): Promise<number> {
  const quota = users[0].leadQueueMultiple ?? 1;
  const result = await redis.eval(
    ROUND_ROBIN_SCRIPT, 1,
    `rr:state:${providerId}`,
    users.length,
    quota
  );
  return result as number;
}
```

Redis guarantees Lua scripts run atomically — no other command interleaves. This gives you compare-and-swap without WATCH/MULTI/EXEC retry loops.

## Distributed Lock for the Full Assignment Flow

The Lua script handles state atomically, but the full flow — fetch lead, check eligibility, write assignment — isn't. A second worker can pick up the same lead before the first commits.

```typescript
async function distributeLead(leadId: string): Promise<void> {
  let lock;
  try {
    lock = await redlock.acquire([`lock:distribute:${leadId}`], 30_000, {
      retryCount: 3,
      retryDelay: 100,
    });
  } catch {
    return; // another worker has it
  }

  try {
    await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findUnique({
        where: { id: leadId },
        include: { vehicles: true },
      });

      // Re-check inside the transaction — another worker may have
      // assigned between queue pop and lock acquisition
      if (!lead || lead.assignedUserId) return;

      const users = await getEligibleUsers(lead.providerId, tx);
      if (!users.length) return;

      const idx = await getNextUserIndex(redis, lead.providerId, users);

      await tx.lead.update({
        where: { id: leadId },
        data: {
          assignedUserId: users[idx].id,
          assignedAt: new Date(),
        },
      });
    }, { isolationLevel: 'RepeatableRead' });
  } finally {
    await lock.release();
  }
}
```

Two points that trip people up:

1. **Check again inside the transaction.** The race between queue pop and lock acquisition is real. The second check costs one query and prevents double assignments.
2. **`RepeatableRead` isolation.** Postgres's default `ReadCommitted` won't protect you if two transactions update the same row concurrently.

## Background Worker with Retry Tracking

```typescript
class LeadWorker {
  private readonly BATCH = 50;
  private readonly POLL_MS = 10_000;
  private readonly MAX_RETRIES = 5;
  private readonly RETRY_TTL = 3600;

  async start(): Promise<void> {
    while (true) {
      const leads = await prisma.lead.findMany({
        where: { assignedUserId: null, isDeleted: false },
        orderBy: { createdAt: 'asc' },
        take: this.BATCH,
      });

      await Promise.all(leads.map((l) => this.process(l.id)));
      await sleep(this.POLL_MS);
    }
  }

  private async process(leadId: string): Promise<void> {
    const key = `retry:lead:${leadId}`;
    const attempts = parseInt((await redis.get(key)) ?? '0');
    if (attempts >= this.MAX_RETRIES) return;

    try {
      await distributeLead(leadId);
    } catch (err) {
      await redis.set(key, attempts + 1, 'EX', this.RETRY_TTL);
      logger.warn({ leadId, attempts: attempts + 1 }, 'distribution failed');
    }
  }
}
```

The retry counter lives in Redis with a 1-hour TTL. After 5 failures, the lead stops blocking the queue — it won't retry forever while fresh leads wait behind it.

## Duplicate Leads: One Source, Multiple Agents

Some providers want multiple agents to see the same lead. The pattern: assign the original to the first agent, create copies for the rest. Each copy needs a unique `outerId` — use `INCR` for a globally atomic counter, no UUID needed.

```typescript
async function createDuplicate(
  original: Lead & { vehicles: Vehicle[] },
  targetUserId: string,
  tx: PrismaTransaction
): Promise<Lead> {
  const sequence = await redis.incr('counter:outerid');
  const outerId = `${config.duplicatePrefix}${sequence}`;

  const { id, assignedUserId, originalLeadId, ...rest } = original;

  const duplicate = await tx.lead.create({
    data: {
      ...rest,
      outerId,
      assignedUserId: targetUserId,
      originalLeadId: original.id,
      isProviderDuplicate: true,
    },
  });

  await tx.vehicle.createMany({
    data: original.vehicles.map(({ id: _id, leadId: _leadId, ...v }) => ({
      ...v,
      leadId: duplicate.id,
    })),
  });

  return duplicate;
}
```

`INCR` is atomic and sequential — no collision, no lock needed, and the IDs sort naturally in your UI.

## Exclusive Providers

For exclusive providers, the user pool is pre-configured with a manual order and per-user quotas. The round-robin logic is identical — just a different pool source:

```typescript
async function getEligibleUsers(
  providerId: string,
  isExclusive: boolean,
  tx: PrismaTransaction
): Promise<User[]> {
  if (isExclusive) {
    const rows = await tx.leadProviderUser.findMany({
      where: { providerId, user: { isActive: true } },
      orderBy: { order: 'asc' },
      include: { user: true },
    });
    return rows.map((r) => ({ ...r.user, leadQueueMultiple: r.quota ?? 1 }));
  }

  return tx.user.findMany({
    where: {
      isActive: true,
      teamId: { not: null },
      leadQueueEnabled: true,
      leadQueuePause: false,
    },
    orderBy: { leadQueueOrder: 'asc' },
  });
}
```

## Edge Cases Worth Knowing

**Redis restart.** If the `rr:state` key expires, the round-robin resets to index 0. For most CRMs this is acceptable — the temporary unfairness corrects itself. If you need durability, persist the state to Postgres periodically and seed Redis from it on startup.

**Queue lag.** The 10-second poll adds up to 10 seconds of latency before a lead is distributed. If you need real-time, replace the poll with a BullMQ job triggered on lead creation — the worker logic stays identical.

**Paused agents.** The `leadQueuePause` flag is checked at distribution time, not at queue time. An agent who pauses mid-batch won't receive leads from that batch, but the round-robin state isn't rewound — the next eligible agent picks up from where it left off.
