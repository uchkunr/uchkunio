---
title: "Big O Notation: The Practical Guide for Working Engineers"
date: "2026-02-15"
excerpt: "Forget the academic proofs. Here's how to spot O(n^2) hiding in your code, why hash maps change everything, and real refactoring examples that turned minutes into milliseconds."
tags:
  - algorithms
  - performance
---

# Big O Notation: The Practical Guide for Working Engineers

I'm not going to define Big O with formal mathematical notation. If you want that, read a textbook. What I'm going to show you is how to look at real code, recognize the performance class it falls into, and refactor it when it's too slow. These are patterns I've used to turn 45-second API endpoints into 200ms responses.

## The Only Complexities You Need to Know

In practice, you'll encounter these five. Everything else is academic:

| Complexity | Name | What it feels like |
|-----------|------|-------------------|
| O(1) | Constant | Instant, regardless of data size |
| O(log n) | Logarithmic | Binary search. Barely grows. |
| O(n) | Linear | Scales directly with data. Predictable. |
| O(n log n) | Linearithmic | Good sorting algorithms. Still fast. |
| O(n^2) | Quadratic | **This is the one that ruins your day.** |

At 100 items, O(n^2) does 10,000 operations. Feels fine. At 10,000 items, it does 100,000,000 operations. Your users are staring at a spinner.

## Spotting O(n^2) in the Wild

The obvious case is a nested loop:

```typescript
// O(n^2) - obvious nested loop
function findDuplicates(items: string[]): string[] {
  const duplicates: string[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i] === items[j]) {
        duplicates.push(items[i]);
      }
    }
  }
  return duplicates;
}
```

But here's the version that hides in production code and nobody notices:

```typescript
// O(n^2) - hidden in Array.includes()
function getUniqueUsers(users: User[]): User[] {
  const unique: User[] = [];
  for (const user of users) {
    if (!unique.find(u => u.id === user.id)) { // .find() is O(n)
      unique.push(user);
    }
  }
  return unique;
}
```

That `.find()` inside a loop is O(n) * O(n) = O(n^2). Same goes for `.includes()`, `.indexOf()`, and `.some()` when used inside a loop. Every one of these scans the array linearly.

The fix is almost always a Set or Map:

```typescript
// O(n) - Set lookup is O(1)
function getUniqueUsers(users: User[]): User[] {
  const seen = new Set<string>();
  return users.filter(user => {
    if (seen.has(user.id)) return false;
    seen.add(user.id);
    return true;
  });
}
```

## The Hash Map Refactoring Pattern

This is the single most useful performance refactoring pattern I know. Any time you're searching an array inside a loop, build a Map first.

**Before: O(n^2)**

```typescript
// Match orders with their products
function enrichOrders(orders: Order[], products: Product[]): EnrichedOrder[] {
  return orders.map(order => ({
    ...order,
    product: products.find(p => p.id === order.productId), // O(n) per order
  }));
}

// With 10,000 orders and 5,000 products: 50,000,000 comparisons
```

**After: O(n)**

```typescript
function enrichOrders(orders: Order[], products: Product[]): EnrichedOrder[] {
  // Build lookup map once: O(n)
  const productMap = new Map(products.map(p => [p.id, p]));

  // Now each lookup is O(1)
  return orders.map(order => ({
    ...order,
    product: productMap.get(order.productId),
  }));
}

// With 10,000 orders and 5,000 products: 15,000 operations
```

I've used this exact pattern to fix performance issues at least 30 times in my career. It's the first thing I look for in slow code.

## Real Refactoring: Syncing Users (45s to 200ms)

Here's a real scenario I encountered. An HR sync job matched employees from an external API with internal user records:

```typescript
// The original code - ran nightly, took 45 seconds
async function syncEmployees(external: Employee[], internal: User[]) {
  const toCreate: Employee[] = [];
  const toUpdate: Employee[] = [];
  const toDeactivate: User[] = [];

  // Find employees to create or update
  for (const emp of external) {
    const existing = internal.find(u => u.email === emp.email); // O(n)
    if (!existing) {
      toCreate.push(emp);
    } else if (existing.name !== emp.name || existing.department !== emp.department) {
      toUpdate.push(emp);
    }
  }

  // Find users to deactivate
  for (const user of internal) {
    const stillActive = external.find(e => e.email === user.email); // O(n) again
    if (!stillActive) {
      toDeactivate.push(user);
    }
  }

  // ... process changes
}
```

With 5,000 external employees and 4,800 internal users, the two nested scans did ~48 million comparisons. Here's the fix:

```typescript
// Refactored - runs in 200ms
async function syncEmployees(external: Employee[], internal: User[]) {
  const toCreate: Employee[] = [];
  const toUpdate: Employee[] = [];
  const toDeactivate: User[] = [];

  // Build lookup maps: O(n) each
  const internalByEmail = new Map(internal.map(u => [u.email, u]));
  const externalEmails = new Set(external.map(e => e.email));

  for (const emp of external) {
    const existing = internalByEmail.get(emp.email); // O(1)
    if (!existing) {
      toCreate.push(emp);
    } else if (existing.name !== emp.name || existing.department !== emp.department) {
      toUpdate.push(emp);
    }
  }

  for (const user of internal) {
    if (!externalEmails.has(user.email)) { // O(1)
      toDeactivate.push(user);
    }
  }
}
```

Same logic. Same results. Two Map/Set constructions (O(n) each) replaced two nested scans (O(n^2) total). The improvement was 225x.

## Array Methods and Their Hidden Costs

Know the complexity of what you're calling:

```typescript
const arr = [1, 2, 3, 4, 5];

// O(1) - constant time
arr[0];          // Index access
arr.push(6);     // Append
arr.pop();       // Remove last

// O(n) - scans the array
arr.includes(3); // Linear search
arr.indexOf(3);  // Linear search
arr.find(x => x > 3);  // Linear search
arr.filter(x => x > 3); // Full scan
arr.map(x => x * 2);    // Full scan
arr.shift();     // Remove first (shifts all elements)
arr.unshift(0);  // Insert first (shifts all elements)

// O(n log n)
arr.sort();      // Comparison sort
```

The dangerous ones are the O(n) methods used inside loops. `.filter().map().find()` chains are fine on their own, but wrap them in a loop and you've got O(n^2) or worse.

## When O(n^2) Is Fine

Not every O(n^2) needs fixing. If your array has 20 items and will never have more, the nested loop is simpler and more readable than the HashMap version.

My rule of thumb:

- **n < 100**: Write the simplest, most readable code. Don't optimize.
- **100 < n < 1,000**: Watch it, but probably fine.
- **n > 1,000**: Use hash maps. Always.
- **n > 100,000**: Start thinking about streaming, pagination, and database-level operations.

```typescript
// This is fine. There are 12 months. There will always be 12 months.
const months = ["Jan", "Feb", "Mar", /* ... */];
const index = months.indexOf("Mar"); // O(12) = O(1) in practice
```

## Database Queries and Big O

The same thinking applies to database access. This is an O(n) query problem (the N+1 query):

```typescript
// O(n) database queries - one per order
const orders = await db.query("SELECT * FROM orders WHERE user_id = $1", [userId]);
for (const order of orders) {
  const product = await db.query("SELECT * FROM products WHERE id = $1", [order.product_id]);
  order.product = product;
}
```

Fixed with a JOIN, or by batching IDs with `WHERE id = ANY($1)` and building a Map from the results. There's the hash map pattern again.

## How to Profile Before You Optimize

Don't guess. Measure. Run your function with different input sizes (100, 1,000, 10,000, 100,000) and time each run with `performance.now()`. If doubling n roughly doubles time, it's O(n). If it quadruples time, it's O(n^2). If it barely changes, it's O(log n) or O(1).

Big O isn't an academic exercise. It's a diagnostic tool. When something is slow, the first question is: what's the complexity class? If it's O(n^2) and you have thousands of items, you know exactly where to look and exactly how to fix it. Build a Map, drop a factor of n, and go home.
