---
title: "The ALTER TABLE lock queue: how a migration stops production"
date: "2026-09-08"
excerpt: "Adding a column is instant, but every query that reaches the table gets stuck behind an ALTER TABLE that is waiting for its lock. This post explains how the lock queue works and why every migration needs lock_timeout."
tags:
  - postgresql
  - migrations
  - reliability
---

Since Postgres 11, `ALTER TABLE orders ADD COLUMN note text` runs instantly: the table is not rewritten, only the catalog changes. Even so, this very command can stop production for several seconds. The cause lies not in the command itself but in the lock it waits for.

## The lock queue

Every query takes a lock on the table. A `SELECT` takes the lightest one, `AccessShareLock`, and runs alongside other `SELECT`s without any trouble. `ALTER TABLE`, on the other hand, requires an `AccessExclusiveLock`, which is compatible with no other lock. The decisive detail is that Postgres grants locks in queue order: a query that arrives later does not get around a heavy lock already waiting in the queue.

Let's verify this with three sessions. A reads the table inside a long transaction, B adds a column, and C sends an ordinary `SELECT`:

```sql
-- A: the transaction stays open for 6 seconds
BEGIN; SELECT count(*) FROM orders;
-- B: one second later
ALTER TABLE orders ADD COLUMN note text;
-- C: one more second later
SELECT count(*) FROM orders;
```

```text
 pid | query                           | wait    | blocked_by
-----+---------------------------------+---------+------------
 116 | BEGIN; SELECT count(*) FROM ... | Timeout | {}
 123 | ALTER TABLE orders ADD COLUMN.. | Lock    | {116}
 130 | SELECT count(*) FROM orders;    | Lock    | {123}
```

C is blocked by B, not by A: the `blocked_by` column holds the ALTER's pid. A and C would not get in each other's way, but the ALTER stands between them in the queue, and every query that reaches the table during those seconds lines up behind it.

![A long SELECT holds its lock, ALTER TABLE waits for it, and every new query queues up behind the ALTER](/sketches/alter/lock-queue.svg)

```text
B ALTER:  waited 5.08 s, then ran instantly
C SELECT: waited 4.09 s
```

Under real traffic there is more than one C: hundreds of queries per second join the queue, the connection pool fills up, and from the outside the service looks completely down.

## lock_timeout

The solution is to never let a migration wait for a lock indefinitely.

```sql
SET lock_timeout = '1s';
ALTER TABLE orders ADD COLUMN note text;
```

```text
B ALTER:  1.09 s  ERROR:  canceling statement due to lock timeout
C SELECT: 0.09 s
```

The ALTER gives up after one second, and the queue clears at once. The migration failed, but that is incomparably cheaper than an outage: it can be retried at a quieter moment.

![A SELECT behind ALTER TABLE waited 4.09 s without lock_timeout and 0.09 s with lock_timeout = 1s](/sketches/alter/wait-race.svg)

```bash
for attempt in 1 2 3 4 5; do
  psql -v ON_ERROR_STOP=1 -c "SET lock_timeout = '1s'; ALTER TABLE orders ADD COLUMN note text;" && break
  sleep $((attempt * 2))
done
```

## Migration rules

- Every migration starts with `SET lock_timeout`. The same holds for ORM migrations: putting it on the first line of the SQL file is enough.
- Long-running transactions are identified before the migration starts: `SELECT pid, now() - xact_start AS age, query FROM pg_stat_activity WHERE xact_start < now() - interval '1 minute';`
- Changes that rewrite the table are not instant: `ALTER COLUMN ... TYPE`, or a column with a VOLATILE default such as `gen_random_uuid()`. These are done by adding a new column and copying the data over in batches.
- Indexes are built with `CREATE INDEX CONCURRENTLY`, which does not block writes to the table.
