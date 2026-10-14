---
title: "SMS through RingCentral: zero 429s with BullMQ, a direct message leaves in 0.5 s ahead of 5000 bulk"
date: "2026-10-14"
excerpt: "With the bulk campaign paced at 1.6 s and direct messages bypassing the queue, 2 of 5 direct messages got a 429 and landed behind 4963 bulk rows. One BullMQ queue per account with priority and a one-request-per-1.67 s limiter brought 429s to zero, a direct message left in 0.5 s, and none of 5005 jobs was lost."
tags:
  - architecture
  - reliability
  - redis
  - nestjs
---

RingCentral allows 40 requests a minute per account (the Medium group), returns 429 above the limit, and may temporarily block the account if the 429s keep coming. In Carlink (a car hauling CRM) every dispatcher sends SMS through their own account, and there are three kinds of sends: bulk (thousands of leads in one click), direct (one number from the chat) and the automatic first message when a lead is assigned. Three requirements: no 429 at all, no message lost, and bulk must not block direct.

## Why the first version was not enough

In the first version bulk messages sat in the Postgres `messages` table in the `Queued` state, each user's Hangfire job sent them at a 1.6 s interval (37.5 a minute), while direct and first messages bypassed the queue and went straight to RingCentral, dropping to `Queued` on a 429. The logic looks simple: an urgent message does not wait in a queue. The problem is that the limit is not enforced in one place. The bulk worker spends 37.5 requests on its own, and direct goes out with no idea how much of that account's budget is left.

Test bench: a fake RingCentral counts 40 requests in a 60-second window and returns 429 from the 41st. One account, 5000 bulk, 5 direct at second 58:

```text
 58.0 s  direct #1 sent
 58.0 s  direct #2 sent
 58.0 s  direct #3 sent
 58.0 s  direct #4 429 -> Queued, behind 4963 bulk rows
 58.0 s  direct #5 429 -> Queued, behind 4963 bulk rows
 59.3 s  bulk  429, Retry-After 1s -> back to Queued
first minute: bulk sent 37, 429 total 3 (direct, direct, bulk)
```

Two direct messages got a 429, dropped to `Queued`, and since the queue is FIFO they ended up behind 4963 bulk rows. The "urgent" message became the slowest message in the system, and RingCentral saw three 429s in one minute.

## The fix: one gate, priority inside the queue

One rule: every request headed for RingCentral goes through the account's single queue, and that queue settles both the limit and the priority. An urgent message does not bypass the queue, it goes to the front of it.

![Every SMS is first a row in Postgres, the outbox relay adds it to the account's BullMQ queue as a job, priority and the limiter set the order inside the queue, the RingCentral webhook writes the delivery status back to the table, and the reconciler cron re-adds rows whose job has gone missing](/sketches/sms/architecture.svg)

Stack: NestJS, `@nestjs/bullmq` and BullMQ 6 (on Redis 7), Postgres (the `messages` table, the outbox), `@nestjs/schedule` (reconciler), RingCentral webhook (delivery). What each part does:

| Part | Role |
| --- | --- |
| `messages` (Postgres) | Source of truth. The row is written in the same transaction as the business record, `idempotency_key` is unique |
| BullMQ queue `sms-{accountId}` | One per RingCentral account. `priority`: direct 1, first message 2, bulk 3. `limiter`: one job per 1.667 s (36 a minute, 10% under 40). `concurrency: 1` |
| Processor | Calls RingCentral. On a 429 it pauses the queue for `Retry-After`, the job spends no attempt |
| Reconciler cron | Re-adds rows that sit in `queued` with no live job. Messages survive even if Redis is wiped |
| Webhook | Writes `delivered` and `failed` to `messages`. "Sent" means RingCentral accepted it, not that it was delivered |

## Code

The message lands in the table first, not in the queue. That gives the HTTP request and the lead event one path, and duplicates stop at the database:

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

The key is built per path: `bulk:{campaignId}:{leadId}`, `direct:{accountId}:{clientRequestId}`, `first:{leadId}`. This is the pattern from the [idempotency keys](/en/blog/idempotency-keys) post, except what is stored is the message row, not an API response.

The queue and worker for each account are created in one process, through a registry. BullMQ 6 does not allow `:` in a queue name, hence `sms-{accountId}`:

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

Enqueuing comes in two forms: one message and a whole campaign. In both, `jobId` is the message id, so if the same message is added twice BullMQ drops the second one:

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

![5000 bulk jobs sit in the account's queue, a direct job arriving with priority 1 is picked up next, and the limiter lets one job through every 1.67 s, so RingCentral never sees a 429](/sketches/sms/priority.svg)

The processor treats three kinds of error three different ways. The 429 matters most: the job does not fail, no attempt is spent, and the whole queue pauses for `Retry-After`:

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

The reconciler is the queue's insurance. Redis wiped, the process died before the job was added, someone cleaned up by hand under `removeOnFail`: in every case the row in Postgres remains and the cron sees it:

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

The webhook has the last word on `messages`. When a subscription is created RingCentral requires the `Validation-Token` header to be echoed back, and after that it sends an event for every message status:

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

Same bench, same load: 5000 bulk, 5 direct at second 58. BullMQ `limiter: { max: 1, duration: 1667 }`, priority direct 1, bulk 3:

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

Zero 429s. The first direct left in 507 ms (the next free slot), the rest one every 1.67 s: even with 4963 bulk jobs waiting, the direct jobs took five consecutive slots. The job count is 42 + 4963 = 5005: 5000 bulk, 5 direct, and the one message the bench deliberately added twice created no extra job.

![The first minute: in the old approach bulk goes out every 1.6 s and the 5 direct messages at second 58 push past the limit of 40, two of them get a 429; in the new approach every request goes out in 1.67 s slots, direct takes the next slots and there is no 429](/sketches/sms/first-minute.svg)

Second test: suppose the provider lowered the limit to 30 without warning, so our limiter at 36 still gets a 429:

```text
 50.2 s  429 from RingCentral: queue paused for 10 s, job b30 kept
 58.0 s  5 direct jobs added
 60.2 s  direct d1 sent after 2164 ms in queue
 ...
 66.9 s  direct d5 sent after 8835 ms in queue
sent 36 (bulk 31, direct 5), 429 total 1, queue pauses 1
job counts: {"waiting":0,"prioritized":4969,"completed":36,"failed":0}
```

One 429, the queue paused for 10 s as `Retry-After` said, the job did not fail, and once the pause ended the direct messages went first. Honesty is due here: the pause stops the whole account, so direct waited 2.2 s as well. That is the right behavior, because every request sent during the pause would have been another 429, and the block would have come closer.

## Tests

Two things are checked without the network: the priority order and that no job is lost after a 429. Redis is real (local or Testcontainers), RingCentral is a fake, and the limiter is lowered to 50 ms in tests, so the test runs in milliseconds rather than seconds:

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

A third test covers the reconciler: a `queued` row is written, the job is deliberately not added, the cron is called once, and the job is expected to appear. A fourth covers the webhook: a request carrying `Validation-Token` returns 200 with that header, and a `Delivered` event sets the row to `delivered`.

## Limits

The BullMQ limiter governs the account's queue and nothing else: any other call that draws on the same account's Medium group (a number list, for example) must also go through this queue, otherwise the limit is split across two places again. One Worker per account means one blocking Redis connection per account: 100 accounts, 100 connections, which is fine, but know your Redis `maxclients`. Grouped queues (one queue, groups per account and a per-group limit) exist in BullMQ Pro, which is paid. When multi-tenancy arrives the queue name becomes `sms-{tenantId}-{accountId}`, and the limit stays at the account level, because that is how RingCentral counts.

## Rules

1. Count the provider's limit at one gate and send every path through it. An "urgent" path that bypasses the queue is the source of 429s.
2. Priority lives inside the queue, together with the limit. An urgent message does not escape the queue, it goes to the front of it.
3. Configure the limiter as an interval, not a window: `1 / 1667 ms` never exceeds 36 in any 60 seconds, while `36 / 60 s` lets 36 through in a burst at the start of the window and gives 429s once it drifts against the provider's window.
4. Do not retry a 429, wait: pause the queue for `Retry-After` and return the job without spending an attempt.
5. Postgres is the source of truth, the queue is the scheduler. Without a reconciler that brings back rows with no live job, messages are lost the day Redis goes down.
