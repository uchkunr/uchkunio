---
title: "Race Conditions in Node.js: They Exist and They'll Bite You"
date: "2026-03-28"
excerpt: "Node.js is single-threaded, but race conditions are real. Here's how they happen in async code and how to prevent them."
tags:
  - nodejs
  - concurrency
  - backend
---

# Race Conditions in Node.js: They Exist and They'll Bite You

"Node.js is single-threaded, so race conditions can't happen." I've heard this countless times. It's wrong.

While Node.js won't have two threads writing to the same memory simultaneously, **async operations create interleaving** that produces the exact same class of bugs.

## The Classic: Check-Then-Act

```typescript
async function withdrawBalance(userId: string, amount: number) {
  const user = await db.users.findById(userId);

  if (user.balance >= amount) {
    // ⚠️ Another request can execute between these two awaits
    await db.users.updateOne(
      { _id: userId },
      { $set: { balance: user.balance - amount } }
    );
  }
}
```

If two requests hit this endpoint simultaneously with a balance of $100 each requesting $80:

1. Request A reads balance: $100 ✓
2. Request B reads balance: $100 ✓
3. Request A sets balance: $100 - $80 = $20
4. Request B sets balance: $100 - $80 = $20

You just gave away $60. This is the **TOCTOU** (Time of Check to Time of Use) problem.

## Fix 1: Atomic Operations

```typescript
async function withdrawBalance(userId: string, amount: number) {
  const result = await db.users.updateOne(
    { _id: userId, balance: { $gte: amount } },
    { $inc: { balance: -amount } }
  );

  if (result.modifiedCount === 0) {
    throw new InsufficientBalanceError();
  }
}
```

The check and update happen in a single atomic operation. No window for interleaving.

## Fix 2: Optimistic Locking

For complex business logic that can't fit in a single query:

```typescript
async function processOrder(orderId: string) {
  const order = await db.orders.findById(orderId);

  // Complex business logic here...
  const result = computeShipping(order);

  const updated = await db.orders.updateOne(
    { _id: orderId, version: order.version },
    {
      $set: { status: "processed", shipping: result },
      $inc: { version: 1 },
    }
  );

  if (updated.modifiedCount === 0) {
    throw new ConcurrentModificationError("Retry the operation");
  }
}
```

## Fix 3: Distributed Locks (Redis)

When you need mutual exclusion across multiple instances:

```typescript
import Redlock from "redlock";

const redlock = new Redlock([redisClient]);

async function processPayment(paymentId: string) {
  const lock = await redlock.acquire([`lock:payment:${paymentId}`], 5000);

  try {
    // Only one instance can execute this at a time
    await doPaymentLogic(paymentId);
  } finally {
    await lock.release();
  }
}
```

## The Sneaky One: In-Memory State

```typescript
const rateLimits = new Map<string, number>();

async function handleRequest(userId: string) {
  const current = rateLimits.get(userId) ?? 0;

  if (current >= 100) {
    throw new RateLimitError();
  }

  // ⚠️ If an await happens here, another request can slip through
  await processRequest(userId);

  rateLimits.set(userId, current + 1); // Uses stale value
}
```

Fix: update the counter **before** the async work:

```typescript
async function handleRequest(userId: string) {
  const current = rateLimits.get(userId) ?? 0;

  if (current >= 100) throw new RateLimitError();

  rateLimits.set(userId, current + 1); // Increment first
  try {
    await processRequest(userId);
  } catch (err) {
    rateLimits.set(userId, (rateLimits.get(userId) ?? 1) - 1); // Rollback
    throw err;
  }
}
```

## Key Takeaway

Every `await` is a potential point where other code can run. The single-threaded model prevents data corruption at the memory level, but your **business logic** can absolutely be corrupted by interleaving.

Rules:
1. Never separate "check" from "act" with an `await` between them
2. Use atomic database operations where possible
3. Use optimistic locking for complex multi-step operations
4. Use distributed locks when coordinating across instances
