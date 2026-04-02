---
title: "Designing Idempotent APIs: Why Your Payment Endpoint Charges Twice"
date: "2026-03-10"
excerpt: "Your user clicked 'Pay' twice and got charged twice. Here's how to design APIs that handle retries, network failures, and duplicate requests without duplicating side effects."
tags:
  - api
  - architecture
  - backend
---

# Designing Idempotent APIs: Why Your Payment Endpoint Charges Twice

A user submitted a payment. The network hiccupped. Their browser retried. They got charged $499 twice. Our support team refunded the duplicate, but the user's bank held the second charge for 5 business days. I got a very unpleasant Slack message from the CEO.

This is the idempotency problem, and every API that mutates state needs to solve it.

## What Idempotency Actually Means

An operation is idempotent if performing it multiple times produces the same result as performing it once. `PUT /users/123 {"name": "Alice"}` is naturally idempotent: setting the name to Alice ten times still results in the name being Alice.

`POST /payments {"amount": 499}` is not naturally idempotent. Each call creates a new payment. That's the one that bites you.

HTTP methods and their natural idempotency:

| Method | Idempotent? | Why |
|--------|------------|-----|
| GET | Yes | Reads don't change state |
| PUT | Yes | Full replacement is repeatable |
| DELETE | Yes | Deleting something already deleted is a no-op |
| PATCH | It depends | Relative changes ("increment by 1") are not idempotent |
| POST | No | Creates a new resource each time |

The problem is that POST is the most common method for critical operations: payments, orders, transfers, notifications.

## The Idempotency Key Pattern

The solution used by Stripe, PayPal, and every serious payment API: the client sends a unique key with each request. The server uses this key to deduplicate.

```typescript
// Client sends a unique key
const response = await fetch("/api/payments", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Idempotency-Key": "pay_8f14e45f-ceea-4f2a-8c3d-bf0e5c9a1234",
  },
  body: JSON.stringify({
    amount: 499,
    currency: "usd",
    customerId: "cus_abc123",
  }),
});
```

The server's logic:

1. Receive the request with idempotency key
2. Check if this key has been seen before
3. If yes, return the stored response (don't execute the operation again)
4. If no, execute the operation, store the response keyed by the idempotency key, return it

```typescript
app.post("/api/payments", async (req, res) => {
  const idempotencyKey = req.headers["idempotency-key"] as string;
  if (!idempotencyKey) {
    return res.status(400).json({ error: "Idempotency-Key header required" });
  }

  // Check for existing response
  const existing = await db.query(
    "SELECT status_code, response_body FROM idempotency_keys WHERE key = $1",
    [idempotencyKey]
  );

  if (existing.rows.length > 0) {
    const stored = existing.rows[0];
    return res.status(stored.status_code).json(JSON.parse(stored.response_body));
  }

  // Execute the payment and store the response for future duplicates
  const payment = await processPayment(req.body);
  await db.query(
    "INSERT INTO idempotency_keys (key, status_code, response_body, created_at) VALUES ($1, $2, $3, NOW())",
    [idempotencyKey, 200, JSON.stringify(payment)]
  );
  return res.status(200).json(payment);
});
```

## The Race Condition Nobody Thinks About

The code above has a critical bug. What if two identical requests arrive at the same time? Both check for an existing key, both find nothing, both execute the payment.

The fix is database-level locking:

```sql
-- The idempotency table
CREATE TABLE idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  status_code INTEGER,
  response_body TEXT,
  request_path VARCHAR(255) NOT NULL,
  request_body_hash VARCHAR(64) NOT NULL,
  locked_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours'
);
```

```typescript
async function withIdempotency(
  key: string,
  requestPath: string,
  requestBody: unknown,
  handler: () => Promise<{ statusCode: number; body: unknown }>
): Promise<{ statusCode: number; body: unknown }> {
  const bodyHash = createHash("sha256")
    .update(JSON.stringify(requestBody))
    .digest("hex");

  // Try to acquire the lock with an atomic INSERT
  try {
    await db.query(
      `INSERT INTO idempotency_keys (key, request_path, request_body_hash, locked_at)
       VALUES ($1, $2, $3, NOW())`,
      [key, requestPath, bodyHash]
    );
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "23505") {
      // Unique violation = key already exists
      // Either we have a stored response or another request is processing
      const existing = await db.query(
        "SELECT status_code, response_body, request_body_hash, locked_at FROM idempotency_keys WHERE key = $1",
        [key]
      );

      const row = existing.rows[0];

      // Verify the request body matches (prevent key reuse for different operations)
      if (row.request_body_hash !== bodyHash) {
        return {
          statusCode: 422,
          body: { error: "Idempotency key already used with different request body" },
        };
      }

      if (row.status_code !== null) {
        // Response already stored, return it
        return { statusCode: row.status_code, body: JSON.parse(row.response_body) };
      }

      // Still processing - tell client to retry later
      return { statusCode: 409, body: { error: "Request is currently being processed" } };
    }
    throw err;
  }

  // We have the lock. Execute the operation.
  try {
    const result = await handler();

    await db.query(
      `UPDATE idempotency_keys SET status_code = $1, response_body = $2, locked_at = NULL
       WHERE key = $3`,
      [result.statusCode, JSON.stringify(result.body), key]
    );

    return result;
  } catch (err) {
    // Remove the key so it can be retried
    await db.query("DELETE FROM idempotency_keys WHERE key = $1", [key]);
    throw err;
  }
}
```

Usage becomes clean:

```typescript
app.post("/api/payments", async (req, res) => {
  const idempotencyKey = req.headers["idempotency-key"] as string;
  if (!idempotencyKey) {
    return res.status(400).json({ error: "Idempotency-Key header required" });
  }

  const result = await withIdempotency(
    idempotencyKey,
    "/api/payments",
    req.body,
    async () => {
      const payment = await processPayment(req.body);
      return { statusCode: 200, body: payment };
    }
  );

  res.status(result.statusCode).json(result.body);
});
```

## Key Design Decisions

### Who generates the idempotency key?

The **client**. Always. If the server generates it, the client doesn't know the key for its retry. The typical pattern is `crypto.randomUUID()` generated before the first attempt and reused on retries.

I keep idempotency keys for 24 hours. Long enough for retries, short enough to not fill the database. A cron job cleans expired keys hourly. Also important: we hash the request body and reject mismatches with a 422 if someone reuses a key with different parameters. Stripe does the same thing.

## Retry Storms: The Amplification Problem

When your server is slow, clients retry. Those retries add load, making the server slower, causing more retries. Defenses: exponential backoff with jitter on the client, server-side rate limiting per idempotency key, and `Retry-After` headers.

```typescript
// Exponential backoff with jitter - the jitter prevents synchronized retry waves
function backoffWithJitter(attempt: number): number {
  const base = Math.min(1000 * Math.pow(2, attempt), 30000);
  const jitter = Math.random() * base * 0.5;
  return base + jitter;
}
```

## Database-Level Deduplication

Add a unique constraint as a final safety net, even with application-level idempotency:

```sql
INSERT INTO payments (idempotency_key, customer_id, amount, currency, status)
VALUES ($1, $2, $3, $4, 'pending')
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING *;
```

If the insert returns no rows, the payment already exists. Query and return the existing record. For operations with natural keys (like a "like" button where user + post is unique), use `ON CONFLICT` on the business identifiers directly instead of opaque UUIDs.

## The Full Picture

Every non-GET API endpoint that has side effects should be idempotent. For some, it's natural (PUT, DELETE). For POST endpoints that create resources or trigger actions, you need explicit idempotency keys.

The implementation has three layers:

1. **Client**: Generates a UUID before the first request, reuses it on retries, uses exponential backoff with jitter
2. **Application**: Checks the idempotency key, acquires a lock, executes the operation, stores the response
3. **Database**: Unique constraints as a final safety net against duplicates

Skip any of these layers and you're leaving a gap. The CEO's Slack message after a double charge is much worse than the afternoon it takes to build this properly.
