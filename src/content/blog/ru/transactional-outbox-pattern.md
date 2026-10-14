---
title: "Transactional Outbox: почему данные и сообщение нужно записывать в одной транзакции"
date: "2026-08-25"
excerpt: "Запись в базу и отправка сообщения в брокер остаются двумя отдельными операциями, и ни в каком порядке их нельзя надёжно связать. Разбираем, как outbox решает эту проблему, как написать relay и когда паттерн избыточен."
tags:
  - architecture
  - postgresql
  - distributed-systems
  - kafka
---

Заказ записывается в базу, а затем в Kafka отправляется событие «заказ оформлен». Это две операции в двух системах, и транзакции, которая бы их объединяла, нет. В каком порядке их ни выполняй, в каждом варианте есть сценарий, при котором данные расходятся:

| Порядок | Где происходит сбой | Результат |
| --- | --- | --- |
| Сначала коммит, потом публикация | Публикация вернула ошибку или процесс упал | Заказ есть, события нет: склад о нём так и не узнает |
| Сначала публикация, потом коммит | Вместо коммита произошёл откат | Событие есть, заказа нет: склад собирает заказ-призрак |
| Публикация внутри транзакции | Потребитель прочитал событие до коммита | Событие пришло, а строка в базе ещё не видна |

Эта проблема называется dual write, и повторными попытками её не решить: если процесс упадёт между двумя операциями, повторять будет уже некому.

## Что это такое

Идея outbox проста: сообщение записывается не в брокер, а в таблицу в той же базе, в одной транзакции с бизнес-данными. Доставкой в брокер занимается отдельный процесс, relay.

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

Теперь заказ и событие либо существуют вместе, либо вместе отсутствуют. Третьего варианта нет, потому что это обычная транзакция Postgres.

![Заказ и строка outbox фиксируются вместе, relay отправляет её в Kafka, потребитель отбрасывает дубликаты](/sketches/outbox/flow.svg)

## Relay

Relay забирает неотправленные строки, отправляет их в брокер и помечает как отправленные. Чтобы несколько relay могли работать параллельно, строки выбираются с `FOR UPDATE SKIP LOCKED`:

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

Вот что происходит, когда два relay запускаются одновременно:

```text
С SKIP LOCKED:       relay-1: 1, 2, 3     relay-2: 4, 5, 6   (одновременно)
Без SKIP LOCKED:     relay-1: 1, 2, 3     relay-2: ждал 2.1 s, пока закончит relay-1
```

## Почему нельзя читать по `id`

Кажется естественным запомнить последний прочитанный `id` и в следующий раз читать с условием `WHERE id > $last`. Но `id` выдаётся в момент вставки строки, а видимой строка становится только после коммита:

```text
tx A: получила id 7, ещё не закоммичена
tx B: получила id 8, закоммичена
relay: id > 6  ->  8        курсор = 8
tx A: закоммичена
relay: id > 8  ->  (пусто)
так и не отправлено: 7
```

![Транзакция A получает id 7, но фиксируется после id 8 из B; relay с курсором навсегда пропускает 7](/sketches/outbox/cursor-gap.svg)

Сообщение 7 не будет отправлено никогда, и никто этого не заметит. Условие `published_at IS NULL` такой ошибке не подвержено: строка, закоммиченная с опозданием, всё равно найдётся на следующем проходе.

## Как минимум один раз

Если relay отправит сообщение и упадёт до `COMMIT`, строки останутся непомеченными, и сообщение уйдёт повторно. Outbox гарантирует, что сообщение не потеряется, но прийти оно может больше одного раза. Поэтому потребитель сам распознаёт дубликаты по `message-id` и делает это в одной транзакции с самой обработкой:

```sql
BEGIN;
INSERT INTO processed_messages (message_id) VALUES (7) ON CONFLICT DO NOTHING;
-- INSERT 0 1: впервые, сообщение обрабатывается
-- INSERT 0 0: дубликат, транзакция закрывается, ничего не сделав
UPDATE stock SET reserved = reserved + 1 WHERE item = 'coffee';
COMMIT;
```

Есть ещё два правила. При нескольких relay порядок событий одного заказа не гарантируется, поэтому, если порядок важен, relay должен быть один. Отправленные строки нужно периодически удалять, иначе outbox будет расти бесконечно. Вместо поллинга можно читать WAL (Debezium): задержка меньше, но инфраструктура тяжелее.

## Когда он нужен

| Ситуация | Outbox |
| --- | --- |
| После изменения в базе событие обязательно должно уйти в Kafka или RabbitMQ | Нужен |
| После изменения другому сервису обязательно должен уйти webhook или email | Нужен |
| Потребитель читает из того же самого Postgres | Не нужен: храните саму очередь в базе ([PGMQ](/ru/blog/postgres-queue-in-your-transaction)) |
| Потеря события ничему не вредит (аналитика, логи) | Не нужен |
| Один сервис, внешние системы не затронуты | Не нужен |

Правило одно: если изменение в базе обязательно должно отразиться в другой системе, запишите и то и другое в одной транзакции, а доставку поручите relay.
