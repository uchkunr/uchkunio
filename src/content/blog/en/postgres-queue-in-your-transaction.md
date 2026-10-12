---
title: "A queue in Postgres: sending a message in the same transaction as the data"
date: "2026-08-04"
excerpt: "When a row written to the database and the message about it are stored in separate systems, the two can drift apart. With PGMQ both fit into a single transaction, and pgmq-ts was written to preserve exactly that property."
tags:
  - postgresql
  - bun
  - typescript
  - open-source
---

When an order comes in, two things usually happen: the order is written to the database, and a message about it is sent to a queue for other services.

```ts
const [order] = await sql`INSERT INTO orders (item) VALUES (${"coffee"}) RETURNING id`;
await producer.send({ topic: "orders", messages: [{ value: order.id }] });
```

These two lines talk to two different systems, and no transaction ties them together. If the process stops after the first line, the order stays in the database and the message is never sent.

[PGMQ](https://github.com/pgmq/pgmq) stores the queue inside Postgres as an ordinary table. Sending a message is therefore just another write to the database, so it becomes part of the same transaction as the order:

```ts
await sql.begin(async (tx) => {
  const [order] = await tx`INSERT INTO orders (item) VALUES (${"coffee"}) RETURNING id`;
  await orderEvents.with(tx).send({ orderId: order.id });
});
```

If an error occurs inside the transaction, neither the order nor the message is saved. Until the commit, other readers cannot see the message.

![With two systems the message is lost when the process dies; in one Postgres transaction the row and the message commit together](/sketches/pgmq/dual-write.svg)

![A transaction that throws leaves no order row and no message; the same transaction without the throw commits both](/media/pgmq-ts-demo.gif)

## The library does not manage the connection

To keep this property intact, [pgmq-ts](https://github.com/uchkunr/pgmq-ts) neither opens connections nor starts transactions on its own. It accepts any object that can execute a query:

```ts
export interface Executor {
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown>;
}
```

Bun's client, a transaction, a savepoint and a reserved connection all match this interface. As a result, a single queue can work with any of them:

```ts
const orders = new Pgmq(sql).queue("orders");

await orders.send(msg);                             // through the pool
await sql.begin((tx) => orders.with(tx).send(msg)); // inside a transaction

const conn = await sql.reserve();
await orders.with(conn).send(msg);                  // on a reserved connection
conn.release();
```

## Four surprises in Bun

I checked every assumption against a running database rather than against the documentation. The results for the first three were obtained on Bun 1.4.2 and Postgres 18.

When JSON in text form is passed to a `jsonb` parameter, Bun wraps it in a string once more, and the database stores a string instead of an object. That is why the library always passes JSON through `::text::jsonb`, which leaves the parsing to Postgres itself:

```ts
const json = JSON.stringify({ a: 1 });

await sql`SELECT jsonb_typeof(${json}::jsonb) AS t`;       // [{ t: "string" }]
await sql`SELECT jsonb_typeof(${json}::text::jsonb) AS t`; // [{ t: "object" }]

await sql`SELECT ${"{bad"}::jsonb`;       // accepted as the string "{bad"
await sql`SELECT ${"{bad"}::text::jsonb`; // invalid input syntax for type json
```

By default Bun returns an `int8` column as a string, and converting it to a plain number loses precision. The library selects every `bigint` column as `::text` and converts it with `BigInt()` itself:

```ts
await sql`SELECT 9007199254740993::int8 AS n`; // [{ n: "9007199254740993" }]
Number("9007199254740993");                    // 9007199254740992
BigInt("9007199254740993");                    // 9007199254740993n
```

Calling `query.cancel()` does not stop the query in the database:

```ts
const q = sql`SELECT pg_sleep(3)`;
setTimeout(() => q.cancel(), 100);
await q; // completed successfully after 3005 ms
```

For this reason `readWithPoll` does not rely on PGMQ's `read_with_poll` function. In its place runs a loop built on a plain `read` and a cancellable `setTimeout`, and as a result stopping takes about 2 milliseconds.

The fourth surprise was the most serious: Bun 1.2.0 silently dropped one of two `delete` calls sent concurrently through the pool, and this happened in 11 out of 20 attempts. The bug was fixed in 1.2.23, which is why `engines.bun` starts at exactly that version.

## The message must not pass through JavaScript

When a worker fails to process a message within the allowed number of attempts, it moves the message to a dead-letter queue. Reading the message in JavaScript and sending it again would be easy, but large numbers get altered along the way:

```ts
JSON.parse('{"n":12345678901234567891}').n; // 12345678901234567000
```

That is why the copy is made entirely in SQL and runs in the same transaction as the deletion of the original message:

```ts
db`
  SELECT sent.msg_id::text AS msg_id
  FROM pgmq.set_vt(${queue}::text, ${msgId}::text::bigint, ${vt}::int) AS m
  CROSS JOIN LATERAL pgmq.send(${target}::text, m.message, m.headers, ${0}::int) AS sent(msg_id)`;
```

## The examples double as tests

Every file in the `examples/` folder verifies its own claim with `assert`:

```ts
// examples/transactional-send.ts: still one order and one message after ROLLBACK
assert.equal(await countOrders(), 1);
assert.equal((await events.metrics()).queueLength, 1n);
```

CI runs these examples against PGMQ 1.10 and 1.13, and against Bun 1.2.23 and the latest release. Every decision and its trade-offs are described in detail in [DECISIONS.md](https://github.com/uchkunr/pgmq-ts/blob/main/DECISIONS.md).
