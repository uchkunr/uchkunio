---
title: "Transactional outbox: real-time chat between microservices"
date: "2026-10-14"
excerpt: "When chat messages between two services went through BullMQ, a Redis outage that coincided with a deploy lost 2 messages out of 10. With a transactional outbox, the same test delivered 10 out of 10, and latency stayed around 10 ms."
tags:
  - architecture
  - postgresql
  - redis
  - bullmq
  - nodejs
---

We have two microservices: Consumers and Workers. A chat runs between them: a message written on one side has to reach the other side in real time and without getting lost. Both services connect to the same Postgres database, but each one works only with its own tables:

```text
consumers.messages   messages sent by Consumers
workers.messages     messages sent by Workers
```

Even though the database is shared, Workers does not read the `consumers.messages` table directly. Otherwise every change to one service's tables would break the other, and someone would still have to announce each new message. So messages travel between the services through the one Redis they both connect to, in a BullMQ queue.

## First version: write to the database, then queue.add

In the first version I wrote the message to the database and added it to the queue right after:

```ts
import { Queue } from "bullmq";

const queue = new Queue("chat-messages", { connection: { host: "127.0.0.1", port: 6379 } });

export async function sendMessage(chatId: number, body: string) {
  const { rows: [message] } = await pool.query(
    "INSERT INTO consumers.messages (chat_id, body) VALUES ($1, $2) RETURNING id, chat_id, body",
    [chatId, body],
  );
  await queue.add("message.created", message);
  return message;
}
```

On the Workers side, a BullMQ worker picks up the job and passes the message to the chat's socket:

```ts
import { Worker } from "bullmq";

new Worker(
  "chat-messages",
  async (job) => io.to(`chat:${job.data.chat_id}`).emit("message", job.data),
  { connection: { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null } },
);
```

On ordinary days this worked. But during deploys and when the connection to Redis dropped, messages started to disappear. To reproduce it, I ran both services as separate processes and sent one message every 400 ms. Workers is redeployed during messages 4-6; during messages 7-8 Redis is down, and Consumers is redeployed at the same moment. The log is trimmed:

```text
  3.8s  deploy:    workers stopped
  3.8s  consumers: msg 4 saved
  4.6s  consumers: msg 6 saved
  5.2s  deploy:    workers started
  5.7s  redis:     down
  5.7s  workers:   msg 4 shown
  5.7s  workers:   msg 6 shown
  5.7s  consumers: msg 7 saved
  6.1s  consumers: msg 8 saved
  6.5s  deploy:    consumers stopped
  7.0s  redis:     up
  7.8s  workers:   msg 10 shown

saved by consumers: 10   received by workers: 8   duplicates skipped: 0
lost: msg 7, msg 8
```

Nothing was lost while Workers was being redeployed: BullMQ keeps the job in Redis, and the worker picks it up when it comes back. Messages 7 and 8, however, were lost. The `INSERT` committed, but `queue.add` never reached Redis: ioredis held the command in its offline queue, that is, in the process's memory. The deploy stopped the process, and the message went away with the memory. As a result, the message is in the database, and Workers never learns about it.

This problem is called a dual write: there are writes to two different systems and no transaction that ties them together. Swapping the order does not help either: if `queue.add` runs first and the `INSERT` then fails, Workers shows a message that does not exist in the database. Retrying is no fix either, because if the process dies between the two writes, nobody is left to retry.

## Second version: transactional outbox

In the next version I applied the transactional outbox pattern. I added an outbox table to each service, and every event is written there:

```sql
CREATE TABLE consumers.outbox (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event      text        NOT NULL,
  payload    jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);
CREATE INDEX outbox_unsent ON consumers.outbox (id) WHERE sent_at IS NULL;
-- workers.outbox is the same
```

Now the message is written not to Redis but to the outbox in the same database, in one transaction with the message itself:

```ts
export async function sendMessage(chatId: number, body: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [message] } = await client.query(
      "INSERT INTO consumers.messages (chat_id, body) VALUES ($1, $2) RETURNING id, chat_id, body",
      [chatId, body],
    );
    await client.query(
      "INSERT INTO consumers.outbox (event, payload) VALUES ('message.created', $1)",
      [message],
    );
    await client.query("NOTIFY consumers_outbox"); // delivered on COMMIT, dropped on ROLLBACK
    await client.query("COMMIT");
    return message;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

With that, the message and its event either both exist or neither does. Even with Redis down, `sendMessage` succeeds, because it writes only to Postgres.

## Relay: from the outbox to BullMQ

A separate process, the relay, carries events to the queue. It takes the unsent rows, adds them to BullMQ and marks them as sent:

```ts
// No offline queue: while Redis is down, addBulk fails at once and the batch rolls back.
const queue = new Queue("chat-messages", {
  connection: { host: "127.0.0.1", port: 6379, enableOfflineQueue: false },
});

async function relayBatch(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, event, payload FROM consumers.outbox
        WHERE sent_at IS NULL
        ORDER BY id
        LIMIT 100
        FOR UPDATE`,
    );
    if (rows.length > 0) {
      await queue.addBulk(rows.map((r) => ({ name: r.event, data: r.payload, opts: { jobId: r.payload.id } })));
      await client.query("UPDATE consumers.outbox SET sent_at = now() WHERE id = ANY($1)", [rows.map((r) => r.id)]);
    }
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

There are three decisions here. The first is `enableOfflineQueue: false`. In the first version it was exactly the offline queue that lost the messages, and the relay must not hold anything in memory: on an error, the rows stay in the outbox and are picked up again on the next pass. The second is the message id as the `jobId`. If the relay dies after `addBulk` but before `COMMIT`, the rows are sent again, and BullMQ does not add a job whose `jobId` already exists. The third is a plain `FOR UPDATE` rather than `SKIP LOCKED`. During a rolling deploy, the old and the new relay run at the same time. `SKIP LOCKED` would let them send different batches in parallel and break the order of the chat. With a plain `FOR UPDATE`, the second relay waits for the first one to finish.

The relay could check the outbox every so often, but for a chat that is slow. So it runs `LISTEN` and wakes up as soon as a commit happens, with the timeout only as a fallback:

```ts
async function runRelay() {
  let wake = () => {};
  const listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await listener.connect();
  await listener.query("LISTEN consumers_outbox");
  listener.on("notification", () => wake());

  for (;;) {
    try {
      while ((await relayBatch()) > 0);
    } catch (error) {
      console.error("relay:", (error as Error).message); // the rows stayed in the outbox; the next pass picks them up
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, 1000);
    });
  }
}
```

## Workers: the inbox and duplicates

The outbox guarantees that a message is not lost, but not that it arrives only once. For example, if a worker shows a message and dies before the job completes, BullMQ finds it stalled and hands it out again. So Workers records each message once in its own table, by message id:

```sql
CREATE TABLE workers.inbox (
  message_id  uuid        PRIMARY KEY,
  chat_id     bigint      NOT NULL,
  body        text        NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
```

```ts
new Worker(
  "chat-messages",
  async (job) => {
    const message = job.data;
    const { rowCount } = await pool.query(
      `INSERT INTO workers.inbox (message_id, chat_id, body) VALUES ($1, $2, $3)
       ON CONFLICT (message_id) DO NOTHING`,
      [message.id, message.chat_id, message.body],
    );
    if (rowCount === 1) io.to(`chat:${message.chat_id}`).emit("message", message);
    // rowCount 0: a duplicate, the message has already been shown
  },
  { connection: { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null } },
);
```

The opposite direction works the same way: `workers.outbox`, its relay and `consumers.inbox`.

## Result

The same test: a Workers deploy, a Redis outage and a Consumers deploy during it. In addition, Workers crashes right after recording message 2 in the inbox. The log is trimmed:

```text
  0.8s  workers:   msg 2 shown
  0.8s  workers:   crashed after recording msg 2
  3.5s  redis:     down
  3.5s  consumers: msg 7 saved
  3.5s  relay:     Stream isn't writeable and enableOfflineQueue options is false
  3.9s  consumers: msg 8 saved
  4.3s  deploy:    consumers stopped
  4.8s  redis:     up
  5.6s  workers:   msg 7 shown
  5.6s  workers:   msg 8 shown
 13.1s  workers:   msg 2 again, already in inbox, skipped

saved by consumers: 10   received by workers: 10   duplicates skipped: 1
lost: none
unsent in outbox: 0
```

Messages 7 and 8 waited in the outbox until Redis came back, and the new relay sent them. The inbox caught message 2 when it arrived again after the crash. I ran the test twice, and the result was the same. The duplicate arrived 12 seconds later because I had set `lockDuration` to 5 seconds for the test; the default is 30 seconds.

For real time, latency matters too, so I sent 100 messages, one every 100 ms, and measured the time from sending to showing:

| Variant | p50 | p95 | Runs |
| --- | --- | --- | --- |
| v1: plain `queue.add` | 6 to 37 ms | 18 to 99 ms | 7 |
| v2: outbox and `NOTIFY` | 9 to 10 ms | 18 to 112 ms | 7 |
| v2: polling only, 1 s | 534 to 541 ms | 985 to 1012 ms | 2 |

The measurements were taken on one machine, in Docker Desktop on Windows, so the results are spread out. The conclusion is clear, though: the outbox did not slow the chat down in any way a user would notice. What keeps it real-time is `NOTIFY`: without it, the relay's median latency goes up to half a second.

## Conclusion

- The message and its event are written in one transaction. Only the relay writes to the broker.
- The relay holds nothing in memory: `enableOfflineQueue: false`, and a rollback on error. Whatever waits in memory is lost on the first deploy.
- A message is delivered at least once, so the receiver drops duplicates by id itself.
- The outbox hands a sent message over to Redis, and from then on its safety depends on Redis itself. The Redis in the test ran with `appendonly yes`. Without AOF, the jobs in the queue are lost when Redis restarts.
