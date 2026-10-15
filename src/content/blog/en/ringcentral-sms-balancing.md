---
title: "5 million SMS a day through RingCentral: rate limits, priority and fairness between tenants"
date: "2026-10-15"
excerpt: "A limit of 40 requests a minute per extension, 1,000 tenants and first messages that must not wait do not fit into a single BullMQ limiter. What is guaranteed, and what is not, once durability, scheduling and rate limiting are split into separate layers."
tags:
  - architecture
  - distributed-systems
  - postgresql
  - kafka
  - rate-limiting
---

The platform has 1,000 tenants, and each of them sends SMS through RingCentral. There are two kinds of messages: first and direct messages, which must not wait, and bulk campaigns that go out to thousands of recipients. RingCentral allows 40 requests a minute per extension and app pair, and several pods call the API.

This task holds three problems that are independent of each other:

1. **Durability.** An SMS job must not be lost when Redis or a pod restarts.
2. **Scheduling.** Something has to decide which tenant and which SMS go next.
3. **Rate limiting.** For one extension and app pair, all pods together must stay within 40 requests a minute.

There is no need to load all three onto a single BullMQ queue limiter. BullMQ can stay for running workers and background jobs, but the sending order and the state of the limit have to be managed independently of it.

## Architecture

```text
NestJS API             first/direct message, bulk campaign
    |
    v
PostgreSQL             sms_outbox, campaign recipients, delivery state, idempotency keys
    |                  (source of truth; transactional outbox or CDC)
    v
Kafka                  durable transport, replay, consumer groups
    |
    v
Scheduler              priority lane (first + direct) | bulk lane (fair across tenants)
                       per-extension eligibility, token bucket or pacing, lease
    |
    v
RingCentral API        a separate rate limit for each extension + app
```

The roles are clearly separated: Kafka delivers messages and allows reading them again, while PostgreSQL keeps the reliable state of which SMS still have to be sent. Even if the queue in Redis is lost entirely, unsent SMS must not be lost.

## The per-extension rate limiter

RingCentral counts its limit by one key:

```text
rate_limit_key = (ringcentral_account_id, extension_id, app_id, api_usage_group)
```

According to the RingCentral documentation, the limit applies to the pair of authenticated user and app, per API group. The default limit for the Medium group is 40 requests a minute, counted over a sliding window, and the `/sms` endpoint is in that group. Once the limit is exceeded, the server rejects every request in that group for a 60-second penalty, and each new request restarts the penalty.

### Why 35 and not 40

40 a minute is the upper bound, not a safe operating point. If each pod sends 40 for the same extension on its own, the limit breaks at once. A starting configuration:

- RingCentral limit: 40 requests/60 seconds.
- Internal target: 35 requests/60 seconds.
- Only 1 active SMS POST at a time per extension.
- When `Retry-After` arrives, no new POST goes out for that key for that long.

35 is just a conservative starting value and can be tuned from what monitoring shows. If a strict guarantee is needed, a central scheduler that matches RingCentral's sliding window is required.

### Where the state lives: Redis or PostgreSQL

| Approach | Advantage | Risk |
| --- | --- | --- |
| Redis Lua and a distributed lock | Fast, tokens are handed out atomically | On restart or failover, state can be lost or an older state restored |
| PostgreSQL transaction and row lock | Durable, shared by all pods | Contention and extra database load at large volume |
| One dispatcher per extension key | Easy to reason about, order is easy to control | With many extensions, partitioning and ownership need managing |

I choose to keep the scheduling state in PostgreSQL, with leases and ownership per extension and central admission control. Redis can only be an accelerating layer; the reliability of the system must not depend on the state of Redis.

```sql
CREATE TABLE sms_rate_limit_state (
  account_id      text        NOT NULL,
  extension_id    text        NOT NULL,
  app_id          text        NOT NULL,
  api_group       text        NOT NULL DEFAULT 'medium',
  next_allowed_at timestamptz NOT NULL DEFAULT now(),
  blocked_until   timestamptz,
  lease_owner     text,
  lease_until     timestamptz,
  PRIMARY KEY (account_id, extension_id, app_id, api_group)
);
```

This table alone is not enough. `next_allowed_at` only works for pacing: at 35 a minute, the minimum interval between requests is 60 / 35, about 1.714 seconds. An exact sliding-window limit also needs the times of the latest requests, or an equivalent atomic state. Each extension has its own queue, and other extensions work independently of it.

### Parallel pods

Several pods must not have the right to send requests for the same extension at the same time. This can be managed with a distributed lease and a fencing token:

1. The dispatcher takes a lease for the extension.
2. The scheduler picks the next message.
3. A request slot is reserved in an atomic operation.
4. The HTTP POST is made.
5. The result is written to durable state.

However, when a lease expires, the old pod may still be sending an HTTP request. RingCentral's API does not check the fencing token itself, so the token does not fully protect the external POST. The lease, the in-flight request timeout and the ownership handover protocol have to be designed together.

## Keeping priority and bulk out of each other's way

Priority can jump the queue, but it cannot bypass the extension's shared rate limit. So each extension has two logical queues: `priority_queue` (first and direct messages) and `bulk_queue` (campaign SMS).

```text
dispatch(extension):
    if now < blocked_until:
        return
    if request_slot_not_available:
        return

    if priority_queue has eligible message:
        message = priority_queue.pop()
    else:
        message = fair_scheduler.next_bulk_message()

    if message exists:
        reserve_rate_limit_slot()
        submit_to_ringcentral(message)
```

Priority goes first only if the HTTP POST for a bulk message has not started yet. A request already on its way to RingCentral cannot be pulled back because a priority message arrived.

The extension's internal budget of 35 requests a minute can be split like this:

- 5 requests/minute reserved for priority messages.
- 30 requests/minute as the main budget for bulk.
- While priority is idle, the spare capacity goes to bulk, but it is handed back as soon as priority arrives.

This is an example, not a universally optimal value. The key condition is that bulk must not take over the whole limit. If priority traffic exceeds its reserve too, it waits within the limit as well: within 40 a minute, no scheduler can guarantee that every priority message goes out immediately.

## Fairness between tenants: not a global FIFO

If each of 1,000 tenants sends 5,000 SMS, the bulk volume is 5 million SMS a day. With a global FIFO, the first tenant's 5,000 SMS push everyone else back. So bulk needs a scheduler such as Deficit Round Robin (DRR) or Weighted Fair Queuing: in every round, active tenants take turns getting one chance each. Even if tenant A has thousands more messages, B and C do not wait for it to finish.

Practical rules:

1. Each tenant has its own bulk queue.
2. Only active tenants take part in the scheduler.
3. The scheduler picks messages from tenants in turn.
4. If a tenant's extension limit is busy for the moment, the scheduler moves on to the next ready tenant.
5. Every selected message still goes through its extension's rate limiter.

Fairness works at two levels. At the tenant level, a large campaign does not keep other tenants waiting forever. At the extension level, priority and bulk share one rate-limit key. If tenants have different numbers of extensions with different limits, plain round robin does not give tenants equal throughput: whether tenants get an equal share or extensions get an equal chance is a separate business decision.

## So that bulk is never lost

Persistent settings in BullMQ and Kafka help, but the requirement cannot be handed to a Redis queue alone. The source of truth is PostgreSQL. When a campaign is created:

1. The campaign and its recipients are written to PostgreSQL.
2. An outbox event is created in the same transaction.
3. The outbox publisher puts the events on Kafka.
4. A consumer prepares the SMS for dispatch.
5. If Redis or Kafka is down for a while, the unfinished work stays in PostgreSQL and is processed later.

```sql
CREATE TABLE sms_outbox (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  extension_id    text        NOT NULL,
  campaign_id     uuid,
  idempotency_key text        NOT NULL UNIQUE,
  message_type    text        NOT NULL,
  payload         jsonb       NOT NULL,
  status          text        NOT NULL DEFAULT 'pending',
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

`status` needs at least these states:

| State | Meaning |
| --- | --- |
| `pending` | Waiting to be sent |
| `claimed` | A dispatcher has taken the work |
| `sending` | The external request is in progress |
| `accepted` | RingCentral accepted the request |
| `retry_wait` | Waiting for the time of the next attempt |
| `unknown` | The outcome of the request is unclear |
| `failed_permanent` | An error that retrying will not fix |

Work stuck in `claimed` can be recovered once its lease expires. Work in `sending`, however, needs the outcome of the external request established before it is sent again automatically. This way, even if every queue in Redis disappears, the `pending` and recoverable work in PostgreSQL is queued again.

## One SMS must not go out twice

This is where the architecture's hardest constraint lies. An idempotency key in PostgreSQL only prevents duplicate work inside the system; it does not guarantee that an SMS does not go out twice through RingCentral:

1. A worker sends a POST to RingCentral.
2. RingCentral accepts the SMS.
3. The response is lost on the network, or the worker crashes.
4. The message is not marked `accepted` in PostgreSQL.
5. The worker sends the job again, and the SMS goes out a second time.

A plain HTTP POST does not guarantee idempotency on the external system. There are three ways to deal with this:

- **If the provider supports an idempotency key.** A stable key is created for each logical SMS and used on every retry. This can be relied on only once the endpoint is confirmed to support the mechanism officially.
- **If the outcome is unclear, reconcile first.** The message moves to `unknown`, it is checked in the RingCentral message store, and the decision is made only once the outcome is clear. Not finding a message does not always prove it was not sent.
- **If the provider offers no idempotency.** A choice has to be made: retry automatically when unsure and lower the risk of loss, or do not resend and lower the risk of a duplicate.

Without an idempotent protocol with the provider or reliable reconciliation, the two guarantees "never lost" and "never duplicated" cannot both be given at once. That is why the `unknown` state is kept separately, and an automatic retry happens only once the outcome is clear. If duplicates are absolutely unacceptable to the business, an unclear case is not resent automatically but sent to a separate review.

## Handling 429

According to the RingCentral documentation, `Retry-After` gives the number of seconds to wait before retrying, and without it the advice is to wait at least 30 seconds. Every request sent during the penalty restarts the penalty.

```text
onRateLimitResponse(extensionKey, response):
    if response.status == 429:
        retryAt = now + RetryAfter(response)
        persistBlockedUntil(extensionKey, retryAt)
        releaseWorker()
        return

    if response.success:
        persistAcceptedState()
        updateRateLimitTelemetry()
```

Things to keep in mind:

- `Retry-After` can be seconds or an HTTP-date, and both are parsed correctly.
- `blocked_until` is stored durably, not in the pod's memory.
- When a 429 arrives for one extension, every dispatcher for that key stops sending new POSTs.
- The worker is not kept busy with `sleep()`: the next attempt is scheduled through `next_attempt_at` or a delayed job.
- The headers are updated on every response: when `X-Rate-Limit-Remaining` drops to zero, wait according to `X-Rate-Limit-Window`.
- `503`, timeouts and network errors are not the same as `429`: their retry and unclear-outcome policies are different.

Pausing the whole system on a 429 is a mistake. Only the affected rate-limit key is blocked, and the other extensions keep working.

## 5 million SMS a day: the capacity math

| Metric | Value |
| --- | --- |
| Daily bulk | 5,000,000 SMS |
| Average rate, whole system | 57.9 SMS/second |
| Theoretical aggregate, 1,000 extensions × 35/minute | 35,000 SMS/minute |
| Capacity of one extension at 35/minute | 2,100 SMS/hour |
| 5,000 SMS for one extension | 143 minutes, that is, 2 hours 23 minutes |

The math assumes 1,000 independent extensions, 35 requests a minute each, and one SMS per POST. This is theoretical capacity, not guaranteed throughput. If all 1,000 extensions start a campaign at the same time, that is no longer a scheduler problem but a capacity problem. The real result depends on priority traffic, other API calls in the Medium group, the provider's additional restrictions and the time window in which a campaign has to finish.

Two more things need accounting for. First, the number of API requests and the number of SMS recipients are not the same thing: if one POST takes several recipients, the two have to be counted separately. Second, for mass and automated messages (campaigns, reminders) RingCentral offers a separate product, High Volume SMS: it allows up to 250,000 SMS a day from one number and up to 10,000 SMS in one API request. Which API the campaigns go through changes both the limits and the math above.

## Stages for going to production

1. **PostgreSQL durability.** The outbox, the idempotency constraint, the state machine, lease recovery and recovering `pending` work.
2. **Per-extension dispatcher.** Shared rate-limit state for all pods, single ownership and durable blocking on `Retry-After`.
3. **Priority and fairness.** Higher priority for first/direct, DRR for bulk, and the priority reserve.
4. **Failure testing.** Redis restart, pod crash, Kafka consumer rebalance, PostgreSQL failover, 429, timeouts and lost HTTP responses.
5. **Observability.** For each extension: request rate, remaining quota, number of 429s, priority wait time, age of the bulk backlog, number of `unknown` states and retry statistics.

## Conclusion

- PostgreSQL is the source of truth for sending state, Kafka is the transport and replay, and Redis and BullMQ are only a fast execution layer: the reliability guarantee does not depend on them.
- The rate limit is managed per extension key, in durable state shared by all pods: 35 requests a minute rather than 40, one POST at a time and blocking on `Retry-After`.
- Priority goes ahead of bulk but does not bypass the limit. Between tenants, DRR runs, not a global FIFO.
- One question stays open: until it is confirmed that the RingCentral SMS endpoint supports an external idempotency key, the guarantees "bulk is never lost" and "one SMS never goes out twice" cannot be promised together.
