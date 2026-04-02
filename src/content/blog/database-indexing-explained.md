---
title: "Database Indexing: What Every Backend Engineer Should Know"
date: "2026-02-25"
excerpt: "Indexes can make or break your application performance. Here's how they work internally and when to use them."
tags:
  - database
  - postgresql
  - performance
---

# Database Indexing: What Every Backend Engineer Should Know

Adding an index turned a 4-second query into 3 milliseconds. Sounds magical, but understanding why requires knowing what's happening under the hood.

## Without an Index

```sql
SELECT * FROM users WHERE email = 'john@example.com';
```

Without an index, PostgreSQL does a **sequential scan** — reads every single row in the table and checks if `email` matches. With 1 million rows, that's 1 million comparisons. O(n).

## With an Index

```sql
CREATE INDEX idx_users_email ON users (email);
```

Now PostgreSQL builds a **B-tree** — a balanced tree structure where it can find any value in O(log n). With 1 million rows, that's ~20 comparisons instead of 1 million.

## B-Tree: The Default

```
              [M]
           /       \
        [D, H]     [Q, U]
       / |  \     / |  \
     [A-C][E-G][I-L][N-P][R-T][V-Z]
```

Every leaf node contains pointers to the actual table rows. Lookups, range queries, and sorting all benefit.

**Good for:**
- Equality: `WHERE email = 'x'`
- Range: `WHERE created_at > '2024-01-01'`
- Sorting: `ORDER BY created_at DESC`
- Prefix: `WHERE name LIKE 'John%'`

**Not useful for:**
- `WHERE name LIKE '%john%'` (no prefix)
- Functions: `WHERE LOWER(email) = 'x'` (use expression index)

## Composite Indexes

```sql
CREATE INDEX idx_orders_user_status ON orders (user_id, status);
```

This helps:
- `WHERE user_id = 1` ✅ (leftmost prefix)
- `WHERE user_id = 1 AND status = 'active'` ✅
- `WHERE status = 'active'` ❌ (skips leftmost column)

**Column order matters.** Put the most selective (most unique values) column first, or the column you filter on most frequently.

## Partial Indexes

Why index rows you'll never query?

```sql
-- Only index active users
CREATE INDEX idx_active_users ON users (email) WHERE active = true;

-- Only index unprocessed orders
CREATE INDEX idx_pending_orders ON orders (created_at) WHERE status = 'pending';
```

Smaller index = faster lookups + less storage + faster writes.

## When Indexes Hurt

Every index has a cost:

1. **Write overhead**: Every INSERT/UPDATE must also update the index
2. **Storage**: Indexes consume disk space
3. **Planner confusion**: Too many indexes can confuse the query planner

### The 80/20 Rule

Most applications need indexes on:
- Primary keys (automatic)
- Foreign keys (not automatic in PostgreSQL!)
- Columns in WHERE clauses
- Columns in JOIN conditions
- Columns in ORDER BY

## EXPLAIN ANALYZE: Your Best Friend

```sql
EXPLAIN ANALYZE SELECT * FROM users WHERE email = 'john@example.com';
```

```
Index Scan using idx_users_email on users
  Index Cond: (email = 'john@example.com')
  Planning Time: 0.1 ms
  Execution Time: 0.05 ms
```

vs without index:

```
Seq Scan on users
  Filter: (email = 'john@example.com')
  Rows Removed by Filter: 999999
  Planning Time: 0.1 ms
  Execution Time: 245.3 ms
```

**Always EXPLAIN before and after** adding an index.

## Common Mistakes

### 1. Indexing Everything

```sql
-- Don't do this
CREATE INDEX idx_1 ON users (first_name);
CREATE INDEX idx_2 ON users (last_name);
CREATE INDEX idx_3 ON users (email);
CREATE INDEX idx_4 ON users (phone);
CREATE INDEX idx_5 ON users (created_at);
```

Instead, analyze your actual queries and create targeted indexes.

### 2. Missing Foreign Key Indexes

```sql
-- PostgreSQL doesn't auto-index foreign keys!
-- If you JOIN or WHERE on user_id, add this:
CREATE INDEX idx_posts_user_id ON posts (user_id);
```

### 3. Ignoring Index-Only Scans

If your query only needs columns that exist in the index:

```sql
CREATE INDEX idx_users_email_name ON users (email, name);

-- This can be served entirely from the index (no table access)
SELECT name FROM users WHERE email = 'john@example.com';
```

## Monitoring

```sql
-- Find unused indexes
SELECT indexrelname, idx_scan, idx_tup_read
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;
```

Delete unused indexes — they're pure overhead.
