---
title: "The N+1 Query Problem: Why Your API is Slow"
date: "2026-03-15"
excerpt: "The N+1 problem is the most common performance killer in backend applications. Here's how to detect and fix it across different ORMs."
tags:
  - database
  - performance
  - backend
---

# The N+1 Query Problem: Why Your API is Slow

Your API endpoint returns 50 users with their posts. It should take one database round-trip. Instead, it takes 51. Welcome to the N+1 problem.

## What Happens

```typescript
// 1 query: SELECT * FROM users
const users = await User.findAll();

for (const user of users) {
  // N queries: SELECT * FROM posts WHERE user_id = ?
  user.posts = await Post.findAll({ where: { userId: user.id } });
}
```

With 50 users, that's **51 queries**. With 500 users, it's 501. Each query has network latency, connection overhead, and query planning cost. It doesn't scale.

## Detecting It

### Log Query Count

```typescript
let queryCount = 0;
const originalQuery = db.query;

db.query = function (...args) {
  queryCount++;
  return originalQuery.apply(this, args);
};

// After handling request
if (queryCount > 10) {
  logger.warn(`Potential N+1: ${queryCount} queries for ${req.path}`);
}
```

### Slow Query Logs

If a simple list endpoint takes >100ms, you likely have an N+1.

## Fix 1: Eager Loading (JOIN)

```typescript
// Sequelize
const users = await User.findAll({
  include: [{ model: Post }],
});

// Prisma
const users = await prisma.user.findMany({
  include: { posts: true },
});

// TypeORM
const users = await userRepo.find({
  relations: ["posts"],
});
```

This generates:

```sql
SELECT users.*, posts.*
FROM users
LEFT JOIN posts ON posts.user_id = users.id
```

One query. Done.

## Fix 2: Batch Loading (DataLoader Pattern)

When JOINs produce too much data duplication:

```typescript
// Collect all user IDs first
const users = await User.findAll();
const userIds = users.map((u) => u.id);

// Single batch query
const posts = await Post.findAll({
  where: { userId: { [Op.in]: userIds } },
});

// Group in memory
const postsByUser = new Map<string, Post[]>();
for (const post of posts) {
  const existing = postsByUser.get(post.userId) ?? [];
  existing.push(post);
  postsByUser.set(post.userId, existing);
}

// Attach
for (const user of users) {
  user.posts = postsByUser.get(user.id) ?? [];
}
```

2 queries total regardless of user count.

## Fix 3: GraphQL DataLoader

If you're using GraphQL, Facebook's DataLoader solves this automatically:

```typescript
const postLoader = new DataLoader(async (userIds: string[]) => {
  const posts = await Post.findAll({
    where: { userId: { [Op.in]: userIds } },
  });

  const map = new Map<string, Post[]>();
  for (const post of posts) {
    const existing = map.get(post.userId) ?? [];
    existing.push(post);
    map.set(post.userId, existing);
  }

  return userIds.map((id) => map.get(id) ?? []);
});

// In resolver - automatically batched
resolve: (user) => postLoader.load(user.id);
```

## Fix 4: Database-Level with Aggregation

Sometimes you don't need the related data—just the count:

```typescript
// ❌ N+1
const users = await User.findAll();
for (const user of users) {
  user.postCount = await Post.count({ where: { userId: user.id } });
}

// ✅ Single query
const users = await db.query(`
  SELECT users.*, COUNT(posts.id) as post_count
  FROM users
  LEFT JOIN posts ON posts.user_id = users.id
  GROUP BY users.id
`);
```

## When JOINs Hurt

JOINs aren't always better:

- **Deep nesting** (users → posts → comments → likes): JOINs create cartesian products
- **Large text columns**: JOINs duplicate the data for each row
- **Pagination**: JOINs make `LIMIT` behave unexpectedly

In these cases, use batch loading (Fix 2) or separate queries with `IN` clauses.

## The Rule

If your endpoint loops over a collection and makes a query inside that loop, you have an N+1. The fix is always the same: **batch the inner query**.
