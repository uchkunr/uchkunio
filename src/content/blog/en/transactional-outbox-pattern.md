---
title: "Transactional Outbox: why data and messages must be written in one transaction"
date: "2026-10-06"
excerpt: "Writing to the database and sending a message to a broker are two separate operations, and no ordering of them links the two reliably. This post explains how the outbox solves the problem, how to write the relay, and when the pattern is unnecessary."
tags:
  - architecture
  - postgresql
  - distributed-systems
  - kafka
---

An order is written to the database, and then an "order placed" event is sent to Kafka. That is two operations on two systems, with no transaction joining them. Whichever order you run them in, each one has a case where the data ends up inconsistent:

| Sequence | Where it breaks | Result |
| --- | --- | --- |
| Commit first, then publish | Publishing fails or the process dies | The order exists but the event does not, so the warehouse never finds out |
| Publish first, then commit | The commit is rolled back | The event exists but the order does not, so the warehouse packs a phantom order |
| Publish inside the transaction | The consumer reads before the commit | The event arrives, but the row is not yet visible in the database |

This problem is known as dual write, and retries cannot solve it: if the process dies between the two operations, there is nobody left to retry.

## What it is

The idea behind the outbox is simple: the message is written not to the broker but to a table in the same database, in the same transaction as the business data. Delivery to the broker is handled by a separate process called the relay.

```sql
CREATE TABLE outbox (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic         text        NOT NULL,
  key           text        NOT NULL,
  payload       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
```

```sql
BEGIN;
WITH o AS (INSERT INTO orders (item) VALUES ('coffee') RETURNING id)
INSERT INTO outbox (topic, key, payload)
SELECT 'order.placed', o.id::text, jsonb_build_object('orderId', o.id, 'item', 'coffee') FROM o;
COMMIT;
```

Now the order and the event either both exist or both do not. There is no third outcome, because this is an ordinary Postgres transaction.

![The order and its outbox row commit together, a relay sends the row to Kafka, the consumer skips duplicates](/sketches/outbox/flow.svg)

## The relay

The relay picks up unpublished rows, sends them to the broker and marks them as published. To let several relays run in parallel, the rows are selected with `FOR UPDATE SKIP LOCKED`:

```ts
import { Kafka } from "kafkajs";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const producer = new Kafka({ brokers: ["localhost:9092"] }).producer();
await producer.connect();

async function relayOnce(batchSize = 100): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, topic, key, payload FROM outbox
        WHERE published_at IS NULL
        ORDER BY id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    for (const row of rows) {
      await producer.send({
        topic: row.topic,
        messages: [{ key: row.key, value: JSON.stringify(row.payload), headers: { "message-id": String(row.id) } }],
      });
    }
    await client.query("UPDATE outbox SET published_at = now() WHERE id = ANY($1)", [rows.map((r) => r.id)]);
    await client.query("COMMIT");
    return rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

Here is what happens when two relays start at the same time:

```text
With SKIP LOCKED:     relay-1: 1, 2, 3     relay-2: 4, 5, 6   (concurrently)
Without SKIP LOCKED:  relay-1: 1, 2, 3     relay-2: waited 2.1 s for relay-1 to finish
```

## Why you cannot read by `id`

It seems natural to remember the last `id` you read and query `WHERE id > $last` the next time. However, an `id` is assigned when the row is inserted, while the row becomes visible only once it is committed:

```text
tx A: took id 7, not committed yet
tx B: took id 8, committed
relay: id > 6  ->  8        cursor = 8
tx A: committed
relay: id > 8  ->  (empty)
never sent: 7
```

![Transaction A takes id 7 but commits after B's id 8; a relay reading by cursor skips 7 forever](/sketches/outbox/cursor-gap.svg)

Message 7 is never sent, and nobody notices. The `published_at IS NULL` condition does not have this flaw: a row that commits late is still picked up on the next pass.

## At least once

If the relay sends a message and dies before `COMMIT`, the rows stay unmarked and the message is sent again. The outbox guarantees that a message is never lost, but it may arrive more than once. The consumer therefore detects duplicates itself by `message-id`, and it does so in the same transaction as the effect itself:

```sql
BEGIN;
INSERT INTO processed_messages (message_id) VALUES (7) ON CONFLICT DO NOTHING;
-- INSERT 0 1: first time, the message gets processed
-- INSERT 0 0: duplicate, the transaction ends without doing anything
UPDATE stock SET reserved = reserved + 1 WHERE item = 'coffee';
COMMIT;
```

Two more rules apply. With several relays, the order of events for a single order is not guaranteed, so if ordering matters, run only one relay. Published rows should also be deleted periodically, otherwise the outbox grows without bound. Instead of polling, you can read the WAL (Debezium): latency is lower, but the infrastructure is heavier.

## When you need it

| Situation | Outbox |
| --- | --- |
| An event must reach Kafka or RabbitMQ after a change in the database | Needed |
| A webhook or email must go to another service after the change | Needed |
| The consumer reads from the same Postgres instance | Not needed: keep the queue itself in the database ([PGMQ](/en/blog/postgres-queue-in-your-transaction)) |
| Losing an event does no harm (analytics, logs) | Not needed |
| A single service with no effect on external systems | Not needed |

There is only one rule: if a change in the database must be reflected in another system, write both in one transaction and leave delivery to the relay.
