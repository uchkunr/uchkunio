---
title: "Idempotency keys: not charging a payment twice on retry"
date: "2026-09-29"
excerpt: "If the network loses the response, the client sends the request again and the money is charged twice. With an idempotency key, five retries arriving at the same time turn into a single payment."
tags:
  - api-design
  - postgresql
  - payments
  - distributed-systems
---

The client sends `POST /charge` and the server charges the money, but the response is lost on the way back: a timeout expired, the mobile network dropped, or the load balancer closed the connection. The client does not know whether the payment went through, so it tries again. Without a key, every attempt is a new payment:

```text
without a key: 5 retries -> 5 payments
```

## The key travels with the request

The client generates one key for each logical operation and keeps it unchanged across all retries:

```http
POST /charge
Idempotency-Key: 7b3e-checkout-A-1001
Content-Type: application/json

{"orderId": "A-1001", "amount": "49.90"}
```

The server stores the key together with the response. A repeated request is not executed again; it receives the stored response instead.

```sql
CREATE TABLE idempotency_keys (
  key          text PRIMARY KEY,
  request_hash text NOT NULL,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

![Five retries with the same key reach the API: one charges the money, four get the stored response](/sketches/idempotency/retries.svg)

## Concurrent attempts

The most dangerous case is when two attempts arrive at the same time. A "check first, then write" approach fails here, because neither of them finds the key. Instead, we leave claiming the key to the database's unique index:

```ts
return sql.begin(async (tx) => {
  const [claimed] = await tx`
    INSERT INTO idempotency_keys (key, request_hash) VALUES (${key}, ${hash})
    ON CONFLICT (key) DO NOTHING
    RETURNING key`;
  if (!claimed) {
    const [row] = await tx`SELECT request_hash, response FROM idempotency_keys WHERE key = ${key}`;
    if (row.request_hash !== hash) return { status: 422, body: { error: "key reused with a different request" } };
    return { status: 200, body: row.response };
  }
  const [p] = await tx`INSERT INTO payments (order_id, amount) VALUES (${body.orderId}, ${body.amount}) RETURNING id`;
  const response = { paymentId: p.id };
  await tx`UPDATE idempotency_keys SET response = ${JSON.stringify(response)}::text::jsonb WHERE key = ${key}`;
  return { status: 201, body: response };
});
```

The second `INSERT` waits for the first one's transaction to finish, which is exactly how a unique index behaves. Once the first commits, `ON CONFLICT DO NOTHING` returns nothing, and the second request reads the finished response. Here are five requests sent at the same time with the same key:

```text
201 {"paymentId":"1"}
200 {"paymentId":"1"} (replayed)
200 {"paymentId":"1"} (replayed)
200 {"paymentId":"1"} (replayed)
200 {"paymentId":"1"} (replayed)
with a key: 5 retries -> 1 payment
```

![The first request claims the key and charges the money; a retry with the same key gets the stored response](/sketches/idempotency/flow.svg)

## Three rules

First, `request_hash` protects against reusing a key for a different request:

```text
{"status":422,"body":{"error":"key reused with a different request"}}
```

Second, the payment provider must receive the same key. Providers such as Stripe accept an `Idempotency-Key` header: if the server sends a request to the provider and dies before it can store the response, the next attempt does not charge the money again on the provider's side either. The provider call is simplified in this example. In a real system, a long external call is not made inside a database transaction; it is managed through `processing` and `done` states.

Third, keys are not kept forever, and a day is usually enough:

```sql
DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours';
```
