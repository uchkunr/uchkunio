---
title: "Database Connection Pooling: Why Your Server Crashes at 100 Concurrent Users"
date: "2026-02-05"
excerpt: "You're opening a new database connection for every request and wondering why your server dies under load. Here's how connection pooling works and how to configure it properly."
tags:
  - database
  - performance
  - backend
---

# Database Connection Pooling: Why Your Server Crashes at 100 Concurrent Users

The first production app I deployed handled 10 concurrent users beautifully. At 50, response times tripled. At 100, PostgreSQL started rejecting connections and the whole thing fell over. The fix was four lines of configuration. But understanding *why* those four lines mattered took me much longer.

## What Happens When You Open a Database Connection

A database connection isn't a simple socket. Here's what PostgreSQL does when your app calls `connect()`:

1. TCP handshake (1 round trip)
2. SSL/TLS negotiation if enabled (1-2 round trips)
3. Authentication (password hashing, LDAP lookup, etc.)
4. PostgreSQL forks a new backend process (yes, a full OS process)
5. The backend process allocates memory for query parsing, planning, and execution

This takes **5-30ms** per connection depending on your setup. And each PostgreSQL backend process consumes **5-10MB of RAM**.

If every HTTP request opens its own connection:

```typescript
// DON'T DO THIS - new connection per request
app.get("/users/:id", async (req, res) => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect(); // 5-30ms overhead EVERY request
  const result = await client.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
  await client.end();
  res.json(result.rows[0]);
});
```

At 100 concurrent requests, you're maintaining 100 PostgreSQL backend processes (500MB-1GB RAM), and every request pays the connection setup cost. PostgreSQL's default `max_connections` is 100, so request 101 gets rejected.

## How Connection Pooling Works

A connection pool maintains a set of open, reusable connections. When your code needs a connection, it borrows one from the pool. When it's done, it returns it. No setup cost, no teardown cost.

```typescript
import { Pool } from "pg";

// Pool is created once, at app startup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,              // Maximum 20 connections in the pool
  idleTimeoutMillis: 30000,  // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Fail if no connection available in 5s
});

// Each request borrows and returns a connection
app.get("/users/:id", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM users WHERE id = $1",
    [req.params.id]
  );
  res.json(result.rows[0]);
});
```

With a pool of 20 connections, those 100 concurrent requests queue up and share the 20 connections. Each connection is reused hundreds of times. Connection setup happens once, not per request.

## Pool Sizing: The Formula That Actually Works

The most common mistake is setting the pool too large. More connections doesn't mean more throughput. It often means less.

PostgreSQL's core performance model is: **each backend process needs CPU time**. If you have more active connections than CPU cores, they contend for CPU and throughput drops.

The formula from the PostgreSQL wiki:

```
pool_size = (core_count * 2) + effective_spindle_count
```

For a typical cloud database with 4 vCPUs and SSDs:

```
pool_size = (4 * 2) + 1 = 9
```

That seems surprisingly small, and it is correct. I've seen a 4-core database perform *worse* with 50 connections than with 10, because of context switching overhead and lock contention.

In practice, I set my pool to **2-3x CPU cores** and tune from there based on monitoring:

```typescript
const pool = new Pool({
  max: 10, // For a 4-core database. Seriously.
});
```

## What Happens When the Pool Is Exhausted

When all connections are in use and a new request comes in, it waits in the pool's internal queue. If it waits longer than `connectionTimeoutMillis`, it throws an error.

```typescript
const pool = new Pool({
  max: 10,
  connectionTimeoutMillis: 5000, // 5 second timeout
});

try {
  const result = await pool.query("SELECT ...");
} catch (err) {
  if (err.message.includes("timeout")) {
    // All connections busy for 5+ seconds
    // This means your pool is too small OR your queries are too slow
    console.error("Connection pool exhausted");
  }
}
```

When you see pool exhaustion, resist the urge to increase `max`. Instead, ask: **why are connections held so long?** Common culprits:

- Slow queries (missing indexes, full table scans)
- Transactions held open during external API calls
- Connections not being returned (missing `finally` blocks)

```typescript
// BAD: holds connection during slow external call
const client = await pool.connect();
try {
  const user = await client.query("SELECT * FROM users WHERE id = $1", [id]);
  const enriched = await fetch(`https://api.external.com/enrich/${user.rows[0].email}`);
  // Connection held for entire external API call!
  await client.query("UPDATE users SET enriched = $1 WHERE id = $2", [enriched, id]);
} finally {
  client.release();
}

// GOOD: release between database operations
const user = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
const enriched = await fetch(`https://api.external.com/enrich/${user.rows[0].email}`);
await pool.query("UPDATE users SET enriched = $1 WHERE id = $2", [enriched, id]);
```

## External Poolers: PgBouncer

When you have multiple application instances (horizontal scaling), each with its own pool, the connections multiply. Ten app instances with a pool of 10 each means 100 connections to PostgreSQL. Time for an external pooler.

PgBouncer sits between your app and PostgreSQL and multiplexes connections:

```ini
# pgbouncer.ini
[databases]
mydb = host=localhost port=5432 dbname=mydb

[pgbouncer]
listen_port = 6432
pool_mode = transaction    # Key setting
max_client_conn = 1000     # Accept up to 1000 app connections
default_pool_size = 20     # But only use 20 PostgreSQL connections
```

The `pool_mode` setting matters:

- **`session`**: Connection assigned for the entire client session (least efficient, most compatible)
- **`transaction`**: Connection assigned per transaction, returned after COMMIT/ROLLBACK (best for most apps)
- **`statement`**: Connection assigned per statement (most efficient, but breaks multi-statement transactions)

I use `transaction` mode in almost every deployment. It lets 1000 application connections share 20 PostgreSQL connections.

## Prisma Connection Pooling

If you're using Prisma, it manages its own pool:

```typescript
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// Connection pool is configured via the URL
// DATABASE_URL="postgresql://user:pass@host:5432/db?connection_limit=10&pool_timeout=10"
```

Or with Prisma Accelerate for serverless:

```typescript
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

// Prisma handles pool internally. Default pool size = num_cpus * 2 + 1
```

The serverless trap: platforms like AWS Lambda spin up new instances per request. Each instance creates its own pool. If Lambda scales to 200 concurrent invocations, that's potentially 200 pools. Use PgBouncer or Prisma Accelerate as a proxy to cap actual database connections.

## Monitoring Your Pool

You can't tune what you can't measure. Expose `pool.totalCount`, `pool.idleCount`, and `pool.waitingCount` as Prometheus metrics. On the PostgreSQL side, query `pg_stat_activity` to see active connections by application. Alert when waiting requests stay above zero for more than 30 seconds (pool saturated) or when active connections approach `max_connections` (you're about to hit the wall).

## The Configuration I Start Every Project With

```typescript
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || "10"),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: true,
});

pool.on("error", (err) => {
  console.error("Unexpected pool error:", err);
});

pool.on("connect", () => {
  console.log("New pool connection established");
});

export default pool;
```

Connection pooling is one of those infrastructure concerns that's invisible when configured correctly and catastrophic when it isn't. Set it up once at project start. Set your pool size to a conservative number based on your database's CPU cores. Monitor the waiting count. You'll handle 100 concurrent users without breaking a sweat, and you'll have a clear path to scaling beyond that.
