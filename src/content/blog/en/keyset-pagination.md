---
title: "Keyset pagination: paging 1800 times faster than OFFSET"
date: "2026-09-15"
excerpt: "With OFFSET, every page is slower than the one before it, because Postgres also reads the rows it is going to throw away. Keyset pagination returns page 49 501 as fast as the first one."
tags:
  - postgresql
  - performance
  - api-design
---

Many APIs implement pagination like this:

```sql
SELECT id, created_at FROM events
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 990000;
```

The first pages load quickly, so the problem does not show up in testing. On a table with 1 million rows and an index on `(created_at, id)`:

```text
OFFSET 0:       0.041 ms
OFFSET 100000:  8.653 ms
OFFSET 990000: 84.783 ms
```

The time grows linearly with the page number. The plan shows why:

```text
Limit (actual rows=20)
  ->  Index Only Scan using events_created_idx on events (actual rows=990020)
```

To return 20 rows, Postgres reads 990 020 entries from the index and throws away 990 000 of them. OFFSET does not know where to start; it only knows how many entries to skip.

![To return 20 rows, OFFSET reads 990 020 index entries, while keyset jumps to the cursor and reads only 20](/sketches/keyset/offset-vs-keyset.svg)

## Continuing from the last row seen

With keyset pagination, you remember the last row of the previous page instead of a page number, and the next query starts exactly from that row:

```sql
SELECT id, created_at FROM events
WHERE (created_at, id) < ('2026-01-01 02:46:41+00', 10001)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

```text
Index Only Scan using events_created_idx on events (actual rows=20)
  Index Cond: (ROW(created_at, id) < ROW('2026-01-01 02:46:41+00', 10001))
Execution Time: 0.047 ms
```

Postgres jumps straight to the cursor in the index and reads only 20 entries. The result is exactly the same rows as with OFFSET 990000, but 1800 times faster.

![Page 49 501 of a 1-million-row table: OFFSET 84.8 ms, keyset 0.047 ms](/sketches/keyset/race.svg)

Two details are decisive. First, `id` is part of the ordering: if several rows share the same `created_at`, the order becomes ambiguous, and rows either repeat on two pages or go missing entirely. Second, the row comparison `(created_at, id) < (...)` matches the index order exactly, so Postgres uses it as a single `Index Cond`. Writing it as `created_at < $1 OR (created_at = $1 AND id < $2)` is logically equivalent, but it may not turn into a single index search.

## In the API

The cursor is handed to the client as an opaque string that the client never needs to look inside:

```ts
const encode = (row: { created_at: Date; id: string }) =>
  Buffer.from(`${row.created_at.toISOString()}|${row.id}`).toString("base64url");

const decode = (cursor: string) => {
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString().split("|");
  return { createdAt, id };
};
```

```json
{ "items": [], "next": "MjAyNi0wMS0wMVQwMjo0Njo0MS4wMDBafDEwMDAx" }
```

Keyset has one limitation: you cannot jump straight to page 37, you can only move forward or backward. For infinite feeds, public APIs and exports, it is the right choice. For admin tables with page numbers, OFFSET is good enough as long as the tables are small.
