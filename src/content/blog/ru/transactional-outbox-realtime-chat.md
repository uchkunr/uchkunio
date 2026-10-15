---
title: "Transactional outbox: real-time чат между микросервисами"
date: "2026-10-13"
excerpt: "Когда сообщения чата между двумя сервисами шли через BullMQ, сбой Redis, совпавший с деплоем, терял 2 сообщения из 10. С transactional outbox в том же тесте дошли 10 из 10, а задержка осталась около 10 мс."
tags:
  - architecture
  - postgresql
  - redis
  - bullmq
  - nodejs
---

У нас два микросервиса: Consumers и Workers. Между ними работает чат: сообщение, написанное на одной стороне, должно дойти до другой в реальном времени и не потеряться. Оба сервиса подключены к одной базе Postgres, но каждый работает только со своими таблицами:

```text
consumers.messages   сообщения, отправленные Consumers
workers.messages     сообщения, отправленные Workers
```

Хотя база общая, Workers не читает таблицу `consumers.messages` напрямую. Иначе любое изменение в таблицах одного сервиса ломало бы другой, а о новом сообщении всё равно кто-то должен был бы сообщить. Поэтому сообщения идут между сервисами через общий Redis, к которому подключены оба, в очереди BullMQ.

## Первая версия: запись в базу, затем queue.add

В первой версии я записывал сообщение в базу и сразу добавлял его в очередь:

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

На стороне Workers воркер BullMQ забирает job и передаёт сообщение в сокет чата:

```ts
import { Worker } from "bullmq";

new Worker(
  "chat-messages",
  async (job) => io.to(`chat:${job.data.chat_id}`).emit("message", job.data),
  { connection: { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null } },
);
```

В обычные дни это работало. Но во время деплоя и при обрывах связи с Redis сообщения начали пропадать. Чтобы воспроизвести это, я запустил оба сервиса отдельными процессами и отправлял по одному сообщению каждые 400 мс. Во время сообщений 4-6 деплоится Workers, во время сообщений 7-8 Redis выключен, и в тот же момент деплоится Consumers. Лог сокращён:

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

Пока деплоился Workers, ничего не потерялось: BullMQ хранит job в Redis, и воркер забирает его, когда возвращается. А вот сообщения 7 и 8 пропали. `INSERT` закоммитился, но `queue.add` до Redis не дошёл: ioredis держал команду в offline queue, то есть в памяти процесса. Деплой остановил процесс, и сообщение исчезло вместе с памятью. В итоге сообщение в базе есть, а Workers никогда о нём не узнает.

Эта проблема называется dual write: есть запись в две разные системы и нет транзакции, которая бы их связывала. Поменять порядок тоже не поможет: если сначала выполнить `queue.add`, а потом `INSERT` упадёт, Workers покажет сообщение, которого нет в базе. Retry тоже не решение: если процесс умрёт между двумя записями, повторять будет некому.

## Вторая версия: transactional outbox

В следующей версии я применил паттерн transactional outbox. Я добавил каждому сервису таблицу outbox, куда записывается каждое событие:

```sql
CREATE TABLE consumers.outbox (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event      text        NOT NULL,
  payload    jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);
CREATE INDEX outbox_unsent ON consumers.outbox (id) WHERE sent_at IS NULL;
-- workers.outbox устроена так же
```

Теперь сообщение пишется не в Redis, а в outbox в той же базе, в одной транзакции с самим сообщением:

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
    await client.query("NOTIFY consumers_outbox"); // доставляется при COMMIT, отбрасывается при ROLLBACK
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

Теперь сообщение и его событие либо существуют вместе, либо вместе отсутствуют. Даже при выключенном Redis `sendMessage` завершается успешно, потому что пишет только в Postgres.

## Relay: из outbox в BullMQ

События в очередь переносит отдельный процесс, relay. Он берёт неотправленные строки, добавляет их в BullMQ и помечает как отправленные:

```ts
// Без offline queue: пока Redis недоступен, addBulk сразу падает, и батч откатывается.
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

Здесь три решения. Первое: `enableOfflineQueue: false`. В первой версии сообщения потеряла именно offline queue, а relay не должен держать ничего в памяти: при ошибке строки остаются в outbox и забираются снова на следующем проходе. Второе: id сообщения в качестве `jobId`. Если relay умрёт после `addBulk`, но до `COMMIT`, строки отправятся повторно, а BullMQ не добавит job с уже существующим `jobId`. Третье: обычный `FOR UPDATE`, а не `SKIP LOCKED`. Во время rolling deploy старый и новый relay работают одновременно. `SKIP LOCKED` позволил бы им отправлять разные батчи параллельно и нарушил бы порядок в чате. С обычным `FOR UPDATE` второй relay ждёт, пока закончит первый.

Relay мог бы время от времени проверять outbox, но для чата это медленно. Поэтому он выполняет `LISTEN` и просыпается сразу после коммита, а таймаут служит только запасным вариантом:

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
      console.error("relay:", (error as Error).message); // строки остались в outbox, следующий проход заберёт их
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, 1000);
    });
  }
}
```

## Workers: inbox и дубликаты

Outbox гарантирует, что сообщение не потеряется, но не гарантирует, что оно придёт только один раз. Например, если воркер покажет сообщение и умрёт до завершения job, BullMQ сочтёт его stalled и выдаст снова. Поэтому Workers записывает каждое сообщение в свою таблицу один раз, по id сообщения:

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
    // rowCount 0: это дубликат, сообщение уже показано
  },
  { connection: { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null } },
);
```

Обратное направление работает так же: `workers.outbox`, его relay и `consumers.inbox`.

## Результат

Тот же тест: деплой Workers, сбой Redis и деплой Consumers во время него. Вдобавок Workers падает сразу после того, как записал сообщение 2 в inbox. Лог сокращён:

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

Сообщения 7 и 8 ждали в outbox, пока Redis не вернулся, и новый relay их отправил. Сообщение 2, пришедшее повторно после падения, остановил inbox. Я провёл тест дважды, результат совпал. Дубликат пришёл через 12 с, потому что для теста я выставил `lockDuration` в 5 с, а значение по умолчанию 30 с.

Для real-time важна и задержка, поэтому я отправил 100 сообщений, по одному каждые 100 мс, и измерил время от отправки до показа:

| Вариант | p50 | p95 | Замеров |
| --- | --- | --- | --- |
| v1: напрямую `queue.add` | от 6 до 37 мс | от 18 до 99 мс | 7 |
| v2: outbox и `NOTIFY` | от 9 до 10 мс | от 18 до 112 мс | 7 |
| v2: только polling, 1 с | от 534 до 541 мс | от 985 до 1012 мс | 2 |

Замеры сделаны на одной машине, в Docker Desktop под Windows, поэтому результаты разбросаны. Но вывод однозначен: outbox не замедлил чат настолько, чтобы это заметил пользователь. А real-time его делает `NOTIFY`: без него медиана задержки relay вырастает до полсекунды.

## Выводы

- Сообщение и его событие записываются в одной транзакции. В брокер пишет только relay.
- Relay ничего не держит в памяти: `enableOfflineQueue: false`, при ошибке откат. Всё, что ждёт в памяти, теряется при первом же деплое.
- Сообщение доставляется хотя бы один раз, поэтому получатель сам отбрасывает дубликаты по id.
- Outbox передаёт отправленное сообщение в Redis, и дальше его сохранность зависит от самого Redis. Redis в тесте работал с `appendonly yes`. Без AOF job'ы в очереди теряются при перезапуске Redis.
