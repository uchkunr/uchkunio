---
title: "Sending notifications at a scheduled time"
date: "2026-10-15"
excerpt: "A cron job running every minute spent more than 130 ms each time to find one minute's reminders among 1 million pills, and a minute skipped during a deploy lost those reminders for good. With a BullMQ job scheduler the repeated query against the database went away, and while the worker was down for 30 seconds, not one of the 1,000 reminders that fell due was lost."
tags:
  - bullmq
  - redis
  - postgresql
  - nodejs
  - scheduling
---

Users take medicine every day at set times: Sitramon at 18:00, Amoxicillin in the morning at 09:00, and so on. Each user does this in their own time zone: 18:00 in Tashkent and 18:00 in Berlin are two different moments. The system has to send a notification 5 minutes after the pill's time, that is, at 18:05.

Pills are stored in the `pills` table with the user's id, and the time is written in the user's local time:

```sql
CREATE TABLE users (
  id       bigint PRIMARY KEY,
  timezone text   NOT NULL            -- IANA: Asia/Tashkent, Europe/Berlin, ...
);

CREATE TABLE pills (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users,
  name    text   NOT NULL,
  take_at time   NOT NULL             -- the user's local time
);

CREATE TABLE notifications (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pill_id    bigint      NOT NULL REFERENCES pills,
  user_id    bigint      NOT NULL,
  due_at     timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pill_id, due_at)
);
```

## First version: cron every minute

In the first version, a cron job called one route every minute. The route finds the pills in `pills` that are due for a reminder in exactly this minute, writes them to `notifications` and sends them:

```sql
INSERT INTO notifications (pill_id, user_id, due_at)
SELECT p.id, p.user_id, date_trunc('minute', now())
FROM pills p JOIN users u ON u.id = p.user_id
WHERE p.take_at + interval '5 minutes' = date_trunc('minute', now() AT TIME ZONE u.timezone)::time
ON CONFLICT DO NOTHING
RETURNING pill_id, user_id;
```

The first problem with this solution is resources. The condition depends on each row's user time zone, so no index on `take_at` can be used, and Postgres reads both tables in full every time. With 50,000 users and 100,000 pills (trimmed):

```text
Hash Join (actual time=15.278..26.014 rows=81.00 loops=1)
  ->  Seq Scan on pills p (actual time=0.006..3.522 rows=100000.00 loops=1)
  ->  Hash (actual time=14.889..14.890 rows=50000.00 loops=1)
        ->  Seq Scan on users u (actual time=0.004..1.872 rows=50000.00 loops=1)
Execution Time: 26.073 ms
```

150,000 rows were read to find 81 reminders. This repeats 1,440 times a day. With ten times the data, 1 million pills, one run took from 131 ms to 141 ms, and Postgres added two parallel workers to it. As a result, the database reads the whole table even in a minute with no reminders at all.

The second problem is more serious. The query checks only the current minute. If the route does not answer at 18:05 during a deploy, that minute's reminders are not found on the next run either. For a user in Tashkent and their 18:00 Sitramon, I ran the route at 18:04, 18:06 and 18:07, while 18:05 fell on a deploy:

```text
pill 1000001, user 8 (Asia/Tashkent), take_at 18:00
cron at 2026-10-15 18:04:00+05:
  for user 8: 0
cron at 2026-10-15 18:06:00+05:
  for user 8: 0
cron at 2026-10-15 18:07:00+05:
  for user 8: 0
notifications for the 18:00 Sitramon of user 8: 0
```

The same query at 18:05 finds this pill:

```text
cron at 18:05: 1 notification(s) for user 8
```

But that run was skipped, and the user never got the reminder. Nobody notices a failure like this: there is no error in the log, the notification simply never arrives.

## Second version: a delayed job in BullMQ

In the second version I removed the cron job that checked every minute. Nobody asks "who needs a reminder now?" every minute anymore. Instead, each pill tells Redis when it is due, and the worker wakes up exactly at that moment. BullMQ has job schedulers for this: one scheduler per pill, with a cron pattern and the user's time zone.

```ts
import { Queue } from "bullmq";

const reminders = new Queue("pill-reminders", { connection });

/** A pill taken at 18:00 is reminded at 18:05, in the user's own time. */
export function reminderPattern(takeAt: string): string {
  const [h, m] = takeAt.split(":").map(Number);
  const minutes = (h * 60 + m + 5) % (24 * 60);
  return `${minutes % 60} ${Math.floor(minutes / 60)} * * *`;
}

export async function schedulePill(pill: { id: number; takeAt: string }, timezone: string) {
  await reminders.upsertJobScheduler(
    `pill-${pill.id}`,
    { pattern: reminderPattern(pill.takeAt), tz: timezone },
    { name: "remind", data: { pillId: pill.id } },
  );
}

export async function unschedulePill(pillId: number) {
  await reminders.removeJobScheduler(`pill-${pillId}`);
}
```

`schedulePill` is called when a pill is added or its time changes, and also when the user changes their time zone. `upsertJobScheduler` replaces the old schedule under the same id, so calling it again is safe. When a pill is deleted, `unschedulePill` is called.

The scheduler itself does no work. It keeps one delayed job in Redis for the next reminder, that is, one entry in a set sorted by time. When the time comes, the worker takes it, and BullMQ immediately creates the next job. To see this, I created a scheduler that runs every 2 seconds and printed the jobs (trimmed):

```text
{"id":"repeat:pill-1:1792042950000", ..., "processedOn":1792042950089, ..., "opts":{..., "prevMillis":1792042950000, ...}}
{"id":"repeat:pill-1:1792042952000","timestamp":1792042950091, ...}
```

The second job was created 2 ms after the first one started, so each pill has only one waiting job in Redis at any time. `prevMillis` holds the moment the job was scheduled for. The worker writes that `prevMillis` as `due_at`, and `UNIQUE (pill_id, due_at)` keeps one reminder from being sent twice:

```ts
import { Worker } from "bullmq";

new Worker(
  "pill-reminders",
  async (job) => {
    const dueAt = job.opts.prevMillis!; // the moment this job was scheduled for
    const { rows } = await pool.query(
      `INSERT INTO notifications (pill_id, user_id, due_at)
       SELECT id, user_id, to_timestamp($2 / 1000.0) FROM pills WHERE id = $1
       ON CONFLICT (pill_id, due_at) DO NOTHING
       RETURNING user_id`,
      [job.data.pillId, dueAt],
    );
    if (rows.length > 0) await sendPush(rows[0].user_id, job.data.pillId);
  },
  { connection: { ...connection, maxRetriesPerRequest: null }, concurrency: 50 },
);
```

Time zone arithmetic is BullMQ's job too. On October 25, Berlin leaves summer time, while Tashkent has no such switch:

```text
Europe/Berlin  18:05 local, first run after 2026-10-24: 2026-10-24T16:05Z
Asia/Tashkent  18:05 local, first run after 2026-10-24: 2026-10-24T13:05Z
Europe/Berlin  18:05 local, first run after 2026-10-26: 2026-10-26T17:05Z
Asia/Tashkent  18:05 local, first run after 2026-10-26: 2026-10-26T13:05Z
```

For the user in Berlin, the UTC time moved by an hour, while the local 18:05 stayed the same.

## Result

In the test I created schedulers for 100,000 pills. Then I set 10,000 more pills to the same minute, the worst case where everyone takes a pill at once. Finally, I stopped the worker for 30 seconds while 1,000 pills fell due, just as during a deploy. The worker is one process with `concurrency: 50`:

```text
100000 schedulers: 14.3 s to create, Redis +99.3 MB (1041 bytes each)
10000 due at 05:48 UTC: sent 10000, late p50 1984 ms, p95 3416 ms, last 3559 ms
worker stopped before 05:49:00 UTC
worker started 30 s after it
1000 due during the deploy: sent 1000, lost 0, late 32134 to 32496 ms; notifications 1000 for 1000 pills
```

All 10,000 reminders that fell in the same minute were sent within 3.6 seconds. The reminders that fell due during the deploy were not lost: they waited in Redis and were sent when the worker came back, with no duplicates. I ran the test twice, and the results agreed.

| | Cron, every minute | BullMQ job scheduler |
| --- | --- | --- |
| Postgres load | The whole table every minute: 26 ms for 100,000 pills, 131 ms to 141 ms for 1 million | One `INSERT` per reminder that is due, nothing else |
| Redis memory | None | About 1 KB per pill: 99 MB for 100,000 pills |
| During a deploy | The reminder is lost | The reminder is late, not lost |

This solution has its price too. The schedule now lives in Redis, so Redis has to run with AOF (the Redis in the test ran with `appendonly yes`). Postgres still remains the source of truth, though: if Redis loses its data, every scheduler can be recreated from the `pills` table. `upsertJobScheduler` is idempotent, and for 100,000 pills this took 14 seconds.

```ts
const { rows } = await pool.query(
  `SELECT p.id, to_char(p.take_at, 'HH24:MI') AS take_at, u.timezone
     FROM pills p JOIN users u ON u.id = p.user_id`,
);
for (let i = 0; i < rows.length; i += 500) {
  await Promise.all(
    rows.slice(i, i + 500).map((p) => schedulePill({ id: p.id, takeAt: p.take_at }, p.timezone)),
  );
}
```

## Conclusion

- A cron job that asks "who needs it now?" every minute slows down as the data grows, and it never gives back a minute it skipped.
- A delayed job keeps the time in Redis: the worker wakes up only for a reminder that is due, and if the worker is down, the reminder waits for it.
- The `tz` option handles time zones and summer time, while the pill's time stays in the database in the user's local time.
- Postgres is the source of truth: Redis runs with AOF, `UNIQUE (pill_id, due_at)` stops duplicates, and the schedulers can be rebuilt from the table at any time.
