---
title: "How to balance millions of SMS through RingCentral: one BullMQ queue per account, priority and no 429s"
date: "2026-10-14"
excerpt: "With bulk sent at a 1.6 s interval and direct bypassing the queue, 2 of 5 direct messages got a 429 and ended up behind 4963 bulk rows. One BullMQ queue per account, priority and a one-request-per-1.67 s limiter: zero 429s, direct left in 0.5 s, none of 5005 jobs lost."
tags:
  - architecture
  - reliability
  - redis
  - nestjs
---

RingCentral limit: 40 requests a minute per account. Above that, 429; repeated 429s and the account is blocked temporarily. We have three kinds of SMS:

- **bulk**: thousands of leads in one request, 5000 is the usual case
- **direct**: an operator sends to one number from the chat
- **first message**: sent automatically when a lead is assigned

Requirements: no 429s, no lost messages, direct and first message do not wait behind bulk.

## Problem

In the first version bulk messages sat in the `messages` table in the `queued` state and a worker sent them at a 1.6 s interval (37.5 a minute). Direct and first message did not enter the queue: they went straight to RingCentral and dropped to `queued` on a 429.

The limit is spent in two places. The worker takes 37.5, direct does not count what is left. Bench: a fake RingCentral counts 40 requests in a 60-second window, 429 from the 41st. One account, 5000 bulk, 5 direct at second 58:

```text
 58.0 s  direct #1 sent
 58.0 s  direct #2 sent
 58.0 s  direct #3 sent
 58.0 s  direct #4 429 -> Queued, behind 4963 bulk rows
 58.0 s  direct #5 429 -> Queued, behind 4963 bulk rows
 59.3 s  bulk  429, Retry-After 1s -> back to Queued
first minute: bulk sent 37, 429 total 3 (direct, direct, bulk)
```

Two direct messages got a 429 and dropped to `queued`. The queue is FIFO, so they ended up behind 4963 bulk rows. RingCentral saw three 429s in one minute.

## Fix

All SMS for one account go through one BullMQ queue: `sms-{accountId}`. Three settings on the queue:

- `priority`: direct 1, first message 2, bulk 3. Lower number is picked first.
- `limiter: { max: 1, duration: 1667 }`: one job per 1.667 s, 36 a minute. 10% under 40.
- `concurrency: 1`.

Direct does not bypass the queue, it goes to the front of it. The limit is counted in one place.

![Every SMS is first a row in Postgres, the relay adds it to the account's BullMQ queue as a job, priority and the limiter set the order in the queue, the RingCentral webhook writes the delivery status back to the table, and the reconciler cron re-adds rows whose job is gone](/sketches/sms/architecture.svg)

Stack: NestJS, BullMQ 6 (Redis 7), Postgres (the `messages` table), `@nestjs/schedule` (reconciler), RingCentral webhook.

| Part | Role |
| --- | --- |
| `messages` (Postgres) | Source of truth. The row is written in one transaction with the business record, `idempotency_key` is unique |
| `sms-{accountId}` (BullMQ) | One per account. priority, limiter, concurrency 1 |
| Processor | Calls RingCentral. 429: the queue pauses for `Retry-After`, the job spends no attempt |
| Reconciler cron | Re-adds rows that sit in `queued` with no job |
| Webhook | Writes `delivered` and `failed` to `messages`. `sent` means RingCentral accepted it, not delivered |

## Code

The message is written to the table first. A duplicate stops at `idempotency_key`:

```ts
// messages.repository.ts
// One row per message. The idempotency key stops the same message from being
// created twice: a retried HTTP request, a re-delivered lead event, a double click.
export type Kind = "direct" | "first_message" | "bulk";

export class MessagesRepository {
  constructor(private readonly db: Pool) {}

  async create(tx: PoolClient, m: { accountId: string; kind: Kind; to: string; body: string; key: string }) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO messages (account_id, kind, "to", body, idempotency_key, status)
       VALUES ($1, $2, $3, $4, $5, 'queued')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [m.accountId, m.kind, m.to, m.body, m.key],
    );
    return rows[0]?.id ?? null; // null: already exists, nothing to enqueue
  }
}
```

Keys: `bulk:{campaignId}:{leadId}`, `direct:{accountId}:{clientRequestId}`, `first:{leadId}`. Same pattern as in the [idempotency key](/en/blog/idempotency-keys) post.

The Queue and Worker for each account are created in a registry. BullMQ 6 does not allow `:` in a queue name:

```ts
// sms-queues.ts
// One Queue and one Worker per RingCentral account. The limiter is the single gate:
// at most one job every 1667 ms, so no 60-second window ever holds more than 36 calls.
import { Queue, Worker, Job } from "bullmq";

export const PRIORITY: Record<Kind, number> = { direct: 1, first_message: 2, bulk: 3 };

@Injectable()
export class SmsQueues implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();

  constructor(private readonly connection: IORedis, private readonly processor: SmsProcessor) {}

  for(accountId: string): Queue {
    let queue = this.queues.get(accountId);
    if (queue) return queue;
    const name = `sms-${accountId}`;
    queue = new Queue(name, { connection: this.connection });
    const worker = new Worker(name, (job) => this.processor.handle(job, worker), {
      connection: this.connection,
      concurrency: 1,
      limiter: { max: 1, duration: 1_667 }, // 36 per minute, under RingCentral's 40
    });
    this.queues.set(accountId, queue);
    this.workers.set(accountId, worker);
    return queue;
  }

  async onModuleDestroy() {
    // Finish the job in flight, then stop; the limiter state stays in Redis.
    await Promise.all([...this.workers.values()].map((w) => w.close()));
  }
}
```

Enqueuing. `jobId` is the message id; if a message is added twice the second one is dropped:

```ts
// sms-enqueue.service.ts
@Injectable()
export class SmsEnqueueService {
  constructor(private readonly queues: SmsQueues) {}

  async one(accountId: string, messageId: string, kind: Kind) {
    await this.queues.for(accountId).add(kind, { messageId }, this.opts(messageId, kind));
  }

  // A 5000-lead campaign is one round trip to Redis, not 5000.
  async campaign(accountId: string, messageIds: string[]) {
    await this.queues.for(accountId).addBulk(
      messageIds.map((messageId) => ({ name: "bulk", data: { messageId }, opts: this.opts(messageId, "bulk") })),
    );
  }

  private opts(messageId: string, kind: Kind): JobsOptions {
    return {
      jobId: messageId,            // idempotent: the same message is one job
      priority: PRIORITY[kind],    // lower number runs first
      attempts: 5,                 // transient errors only, see the processor
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 10_000,    // keep a window of history for the dashboard
      removeOnFail: false,         // failed jobs stay visible until someone looks
    };
  }
}
```

![5000 bulk jobs sit in the account's queue, a direct job arriving with priority 1 is picked up next, the limiter lets one job through every 1.67 s, RingCentral sees no 429](/sketches/sms/priority.svg)

Processor. On a 429 the job does not fail, no attempt is spent, the queue pauses for `Retry-After`:

```ts
// sms.processor.ts
@Injectable()
export class SmsProcessor {
  constructor(private readonly messages: MessagesRepository, private readonly rc: RingCentralClient) {}

  async handle(job: Job<{ messageId: string }>, worker: Worker) {
    const message = await this.messages.get(job.data.messageId);
    if (!message || message.status !== "queued") return; // already sent or cancelled

    // Written before the call: if the process dies here, the row is "maybe sent"
    // and the reconciler will not blindly re-add it.
    await this.messages.setStatus(message.id, "sending");
    try {
      const sent = await this.rc.sendSms(message.accountId, message.to, message.body);
      await this.messages.markSent(message.id, sent.id); // the webhook will upgrade it to delivered
    } catch (e) {
      if (e instanceof RingCentralError && e.status === 429) {
        // Pause this account's queue for the provider's window; the job stays queued.
        await worker.rateLimit((e.retryAfter ?? 60) * 1000);
        await this.messages.setStatus(message.id, "queued");
        throw Worker.RateLimitError();
      }
      if (isNonRetryable(e)) {
        // Invalid number, opted out, blocked content: retrying cannot help.
        await this.messages.markFailed(message.id, e.code);
        return;
      }
      await this.messages.setStatus(message.id, "queued");
      throw e; // transient: attempts and backoff take over
    }
  }
}
```

Reconciler. If Redis is wiped, the process dies before the job is added, or someone clears the failed set, the row stays in Postgres and the cron re-adds it:

```ts
// sms-reconciler.ts
@Injectable()
export class SmsReconciler {
  constructor(private readonly messages: MessagesRepository, private readonly queues: SmsQueues, private readonly enqueue: SmsEnqueueService) {}

  @Cron("*/2 * * * *")
  async run() {
    // "sending" older than 5 minutes: the worker died mid-call. Back to queued.
    await this.messages.requeueStale("sending", "5 minutes");

    // queued rows whose job is gone: re-add them under the same jobId.
    for (const row of await this.messages.queuedOlderThan("1 minute")) {
      const job = await this.queues.for(row.accountId).getJob(row.id);
      if (!job) await this.enqueue.one(row.accountId, row.id, row.kind);
    }
  }
}
```

Webhook. When the subscription is created RingCentral expects the `Validation-Token` header echoed back, then sends an event for every message status:

```ts
// ringcentral-webhook.controller.ts
@Controller("webhooks/ringcentral")
export class RingCentralWebhookController {
  constructor(private readonly messages: MessagesRepository) {}

  @Post()
  @HttpCode(200)
  async receive(@Headers("validation-token") token: string | undefined, @Res({ passthrough: true }) res: Response, @Body() event: RcEvent) {
    if (token) {
      res.setHeader("Validation-Token", token); // subscription handshake
      return;
    }
    const { id, messageStatus } = event.body;
    if (messageStatus === "Delivered") await this.messages.markDelivered(id);
    if (messageStatus === "DeliveryFailed" || messageStatus === "SendingFailed") await this.messages.markFailed(id, messageStatus);
  }
}
```

## Measurement

Same bench, same load: 5000 bulk, 5 direct at second 58:

```text
  0.4 s  5000 bulk jobs added
 58.4 s  5 direct jobs added
 58.9 s  direct d1 sent after 507 ms in queue
 60.5 s  direct d2 sent after 2174 ms in queue
 62.2 s  direct d3 sent after 3842 ms in queue
 63.9 s  direct d4 sent after 5511 ms in queue
 65.6 s  direct d5 sent after 7179 ms in queue
sent 42 (bulk 37, direct 5), 429 total 0, queue pauses 0
job counts: {"waiting":0,"prioritized":4963,"completed":42,"failed":0}
```

Zero 429s. The first direct left in 507 ms, the rest one every 1.67 s. 42 + 4963 = 5005: 5000 bulk, 5 direct. The bench deliberately added one message twice; it created no extra job.

![The first minute: in the old version bulk goes out every 1.6 s, the 5 direct messages at second 58 push past the limit of 40, two get a 429; in the new one every request goes out in 1.67 s slots, direct takes the next slots, no 429](/sketches/sms/first-minute.svg)

Second test: the provider lowered the limit to 30, our limiter is still at 36:

```text
 50.2 s  429 from RingCentral: queue paused for 10 s, job b30 kept
 58.0 s  5 direct jobs added
 60.2 s  direct d1 sent after 2164 ms in queue
 ...
 66.9 s  direct d5 sent after 8835 ms in queue
sent 36 (bulk 31, direct 5), 429 total 1, queue pauses 1
job counts: {"waiting":0,"prioritized":4969,"completed":36,"failed":0}
```

One 429, the queue paused for 10 s, `failed` zero. Direct waited during the pause too (2.2 s). That is correct: a request sent during the pause is another 429.

## Tests

Redis is real, RingCentral is a fake, the limiter is 50 ms in tests. Two things are checked: the priority order and that no job is lost after a 429:

```ts
// sms.e2e.spec.ts
class FakeRingCentral implements RingCentralClient {
  sent: string[] = [];
  failWith429 = 0; // how many calls to reject before behaving

  async sendSms(_account: string, to: string) {
    if (this.failWith429-- > 0) throw new RingCentralError(429, "Too Many Requests", { retryAfter: 1 });
    this.sent.push(to);
    return { id: `rc-${this.sent.length}` };
  }
}

it("a direct message overtakes a 1000-job bulk campaign", async () => {
  await enqueue.campaign("acc-1", bulkIds); // 1000 queued rows
  await enqueue.one("acc-1", directId, "direct");
  await waitFor(() => rc.sent.length >= 2);
  expect(rc.sent[0]).toBe(directTo);       // first slot after the one already running
  expect(rc.sent.slice(1).every((to) => to.startsWith("+1555"))).toBe(true);
});

it("a 429 pauses the queue and loses nothing", async () => {
  rc.failWith429 = 1;
  await enqueue.campaign("acc-1", bulkIds.slice(0, 20));
  await waitFor(() => rc.sent.length === 20, { timeout: 5_000 }); // resumes after retryAfter
  const counts = await queues.for("acc-1").getJobCounts("failed", "completed");
  expect(counts).toEqual({ failed: 0, completed: 20 });
  expect(await messages.countByStatus("acc-1", "failed")).toBe(0);
});
```

Reconciler test: a `queued` row is written, no job is added, the cron is called, the job is expected to appear. Webhook test: a request with `Validation-Token` returns 200 with that header, a `Delivered` event sets the row to `delivered`.

## Limits

- Other calls that use the same account's Medium group (a number list, for example) must also go through this queue. Otherwise the limit is spent in two places again.
- Each Worker is one blocking Redis connection: 100 accounts, 100 connections. Check `maxclients`.
- BullMQ Pro has groups: one queue, a group per account and a group limit. Paid.
- Multi-tenancy: the queue name is `sms-{tenantId}-{accountId}`, the limit stays at the account level.

## Rules

1. One account, one queue. bulk, direct, first message, all through it.
2. Priority inside the queue: direct 1, first message 2, bulk 3.
3. Limiter `1 / 1667 ms`, not `36 / 60 s`. The second lets 36 through in a burst at the start of the window and gives 429s when it drifts against the provider's window.
4. 429: `worker.rateLimit(retryAfter)`, `Worker.RateLimitError()`. Pause, not retry.
5. Postgres is the source of truth, BullMQ the scheduler. The reconciler re-adds rows with no job.
