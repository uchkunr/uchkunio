---
title: "Connection pool size: why 100 connections are slower than 10"
date: "2026-09-22"
excerpt: "A bigger pool does not make the database faster. On a 2-core Postgres, 100 connections completed 5.4 times fewer transactions than 10 and responded 54 times more slowly."
tags:
  - postgresql
  - performance
  - connection-pooling
---

When a service slows down, the first setting people reach for is often the pool size: raise it from 10 to 100, more queries run in parallel, so everything gets faster. With Postgres, this reasoning produces the opposite result.

## The measurement

Postgres 18 runs in a container limited to 2 CPUs. pgbench runs from a separate container with the standard TPC-B workload, in which every transaction contains several `UPDATE`, `SELECT` and `INSERT` statements.

```bash
pgbench -i -s 10 postgres
pgbench -c 10  -j 4 -T 15 postgres
pgbench -c 100 -j 4 -T 15 postgres
```

| Connections | TPS | Average latency |
| --- | --- | --- |
| 10 | 3614 | 2.8 ms |
| 100 | 665 | 150.5 ms |
| 200 | 689 | 290.3 ms |

Ten times as many connections did 5.4 times less work and responded 54 times more slowly.

![Postgres on 2 CPUs: TPS at 10, 100 and 200 connections under the TPC-B and read-only workloads](/sketches/pool/throughput.svg)

## Why this happens

Postgres starts a separate process for every connection. On 2 cores, at most two processes run at any moment, the rest wait their turn, and the operating system switches between them constantly. On top of that, TPC-B has only 10 branch rows, and every transaction updates one of them, so 100 connections end up waiting on each other for the locks on those same 10 rows.

The read-only (`-S`) workload has no row locks, but the picture is similar:

| Connections | TPS | Average latency |
| --- | --- | --- |
| 10 | 6561 | 1.5 ms |
| 100 | 5837 | 17.1 ms |
| 200 | 5339 | 37.5 ms |

Throughput did not go up, while latency grew by a factor of 11. Extra connections do not speed up the work. They only move the queue from the application into the database, and there the queue is more expensive, because a waiting query occupies CPU time and memory.

![Average TPC-B transaction latency: 2.8 ms at 10 connections, 150.5 ms at 100 connections](/sketches/pool/latency-race.svg)

## How big the pool should be

The starting formula from the PostgreSQL wiki is `cores × 2 + disks`. On a 2-core server, that comes to about 5. After that, measurement decides: past the point where TPS stops growing, every additional connection only adds latency.

This number applies to the database as a whole, not to each instance of the service. Ten pods with `max: 20` each open 200 connections to the database. In that situation, PgBouncer sits between the service and the database: the applications can open thousands of connections, while only a few dozen reach the database in transaction mode.

```ini
[pgbouncer]
pool_mode = transaction
default_pool_size = 10
max_client_conn = 2000
```

In transaction mode, a connection belongs to the application only for the duration of a transaction, so settings tied to the session do not work. The `set_config(..., true)` call from the [multi-tenancy post](/en/blog/multi-tenancy-with-row-level-security) works correctly in this mode too, but a plain `SET` does not.
