---
title: "SMS through RingCentral: bulk in a queue, direct messages right away, 40 requests a minute"
date: "2026-10-14"
excerpt: "When one user sends 5000 SMS, nobody else's direct message or first message to a lead should get stuck behind them in a queue. Carlink solves it with a state machine in Postgres, one Hangfire job per user and two keys in Redis."
tags:
  - architecture
  - reliability
  - redis
---

RingCentral allows 40 requests a minute per user (the Medium group). In Carlink (a car hauling CRM) every dispatcher sends SMS through their own RingCentral account, and there are three kinds of sends: bulk (thousands of leads in one click), direct (one number from the chat) and the automatic first message when a lead is assigned. The requirement is simple: bulk must never block the other two, no message may be lost after a 429, and none may go out twice.

## Three paths, one table

Priority is not a property of the queue in this system. Only bulk enters the queue; the other two paths go straight to RingCentral:

- **Bulk.** The `SendSMS` endpoint looks at the number of recipients: if there is more than one, it writes a row per lead into the `Messages` table in the `Queued` state and returns `202 Accepted`. Sending happens later, in the background.
- **Direct.** With a single number the row is written as `Pending`, moved to `Sending`, and RingCentral is called inside the same request. On a response it becomes `Sent`; on a 429 the row drops to `Queued` and the queue worker sends it later; on any other error it becomes `Failed`.
- **First message to a lead.** When a lead is assigned to a user, a Hangfire job sends through the same direct path. On a 429, that user's queue worker is scheduled after `Retry-After` or 65 seconds, whichever is larger.

![Bulk messages land in the Postgres queue and go out through each user's own Hangfire job at a 1.6 second interval; direct and first-to-lead messages bypass the queue and go straight to RingCentral, falling back to the queue only on a 429](/sketches/sms/paths.svg)

That is why a bulk campaign from 30 users cannot delay a direct message: they are not in the same queue at all. Bulk only occupies the `sms` workers; direct goes out inside the HTTP request itself.

## The queue: a state machine in Postgres

There is no separate queue store. The message is already in the `Messages` table, and the `SmsStatus` column is its position in the queue:

```text
Queued  -> Pending  -> Sending -> Sent
                               -> Failed      (non-retryable error)
                               -> Queued      (429, token expiry, transient error)
```

A `Queued` message is waiting for a worker, `Pending` has been picked up by one, and `Sending` means the RingCentral call has started but no response has arrived yet. That last state is written before the RingCentral call on purpose: if the process dies at that moment, the message can be told apart as "possibly sent".

## One worker per user

The dispatcher (`ProcessPendingSmsAsync`) runs every 5 minutes by cron and after every bulk send. It finds the users who have `Queued` rows and creates one job for each. The job itself (`ProcessUserSmsAsync`) takes that user's 200 oldest `Queued` messages, marks them all `Pending`, groups them by `From` number, sends them one by one, and re-enqueues itself if more than 200 remain. These jobs run on a dedicated Hangfire `sms` queue with 5 workers: at most 5 users send at the same time, the rest wait their turn between 200-message chunks.

Redis guarantees two things here, both with a single `SET NX EX`:

```text
sms:dispatch:{userId}      SET NX EX 600   one dispatch job per user at a time
sms:user:{userId}:lock     SET NX EX 900   one sender per user at a time
ringcentral:token:{userId} cache           token, refreshed 20 minutes before expiry
```

Without the dispatch key, the cron and the bulk endpoint would create two jobs for the same user. The lock keeps two jobs from sharing one user's 40 requests/minute budget; it is released with a Lua script that deletes "only if the value is mine", so an expired lock is never removed by another job. If the lock is not acquired, the job exits quietly: the messages stay `Queued`, and the next dispatch picks them up.

## 40 requests a minute

The worker waits 1600 ms between two messages, which is 37.5 requests a minute. The remaining budget is read from RingCentral's response headers: when `X-Rate-Limit-Remaining` drops to 2, the worker sleeps for `X-Rate-Limit-Window` plus 2 seconds and then carries on. A 429 is never retried inline: the error is classified and the job schedules itself for later.

| Error type | Message | Next attempt |
| --- | --- | --- |
| Non-retryable (invalid number, MSG-240, opt-out) | `Failed` | none, the next group continues |
| Rate limit (429, CMN-301) | `Queued` | after 60 s |
| Token expiry (401, OAU-213) | `Queued`, token cache cleared | after 10 s |
| Other (transient) | `Queued` | after 30 s |

Hangfire's own retry is disabled (`Attempts = 0`). In the previous version every error created a separate retry job, and one user's 429s turned into 450 jobs a minute. Now, as soon as the first "stopping" error appears in a group, the remaining messages are returned to `Queued` and the whole job ends with a single scheduled attempt.

![At a 1.6 second interval 37.5 SMS go out per minute; when the remaining budget drops to 2 the worker waits for the window to end and then continues](/sketches/sms/pacing.svg)

## Nothing lost, nothing sent twice

Every state has a deadline. On each run the dispatcher returns rows that have been `Sending` for more than 5 minutes, and `Pending` for more than 15 minutes, to `Queued`: whether the worker died, a deploy happened or the lock expired, the message goes back into the queue. The number of messages that have been `Queued` for more than 10 minutes is a separate metric (`sms_queue_stuck_total`); when it starts growing, there are not enough workers.

Sending twice is prevented by a unique index on `Messages.IdempotencyKey`, and the key differs per path:

```text
bulk:{batchId}:{leadId}:{callerId}      one message per lead per campaign
manual:{callerId}:{X-Client-Request-Id} a request resent from the chat
first_msg:{leadId}:{callerId}           the first message to a lead, once
```

In bulk with `allowDuplicates=false` the key carries a hash of the text instead of `batchId`: the same text is never sent to the same lead a second time. A `Failed` row has its key cleared, so it can be resent. This is the same pattern as in the [idempotency keys](/en/blog/idempotency-keys) post, except that what is stored is the message row, not an API response.

## Limits

To be honest: direct and the queue know nothing about each other. A direct message sent while a bulk is in flight draws from that user's 40 requests/minute budget, and if it hits a 429 it drops to `Queued` and, since the queue is FIFO, waits behind the older bulk rows. `Sent` also means "RingCentral accepted it", not delivered: the delivery webhook is not wired up. The queue query (`CreatedBy`, `SmsStatus`) runs without an index, and once the table grows that will be the first thing to show.

## How it is tested

The project's tests are in xUnit, with the RingCentral client replaced by one that always returns 429: every message must then end up `Queued`, and the whole queue logic of the system is checked without the network. What is checked: 1000 and 5000 parallel sends produce exactly that many rows; 50 users x 30 leads give 1500 rows and no duplicate numbers; when one campaign is sent twice the second is `skipped`; `Sending` returns to `Queued` after 5 minutes; the `Sending` state is written before the RingCentral call.

The same ideas look like this in NestJS and Jest. A fake that throws 429 instead of RingCentral, an in-memory `Map` instead of the repository:

```ts
class RateLimitedRingCentral implements RingCentralClient {
  calls = 0;
  async sendSms(): Promise<never> {
    this.calls++;
    throw new RingCentralError(429, "Too Many Requests", { retryAfter: 60 });
  }
}

it("5000 parallel sends: all Queued, none lost", async () => {
  const batches = users.map((u) => service.enqueueBulk(u.id, leadsOf(u), "Hi {{name}}", { allowDuplicates: true }));
  await Promise.all(batches);
  const rows = [...repo.values()];
  expect(rows).toHaveLength(5000);
  expect(rows.every((m) => m.status === "Queued")).toBe(true);
  expect(new Set(rows.map((m) => m.idempotencyKey)).size).toBe(5000);
});
```

The second test checks the order of states. The fake client records which state the message is in at the moment it is called:

```ts
it("the Sending state is written before the RingCentral call", async () => {
  const seen: string[] = [];
  rc.sendSms = async ({ messageId }) => {
    seen.push(repo.get(messageId)!.status);
    return { id: "rc-1" };
  };
  await worker.processUser(user.id); // with 1 Queued message
  expect(seen).toEqual(["Sending"]);
  expect(repo.get(message.id)!.status).toBe("Sent");
});
```

The third checks the dispatch key: with `ioredis-mock`, when `SET NX` is called twice, the second dispatcher must not create a job. These three tests cover the queue's three core promises: nothing is lost, nothing is sent twice, one sender per user at a time.

## Rules

1. Solve priority outside the queue, not inside it: an urgent message should never enter the queue at all.
2. Do not guess the limit, read it from the provider's headers, and never retry a 429 inline.
3. Do not hand retries to the framework: classify the error and let each job schedule itself once, otherwise jobs multiply.
4. Put a deadline on every state in the queue and write a cron that returns the expired ones. A worker dying is a normal event.
