---
title: "Transactional Outbox: ma'lumot va xabar nega bir tranzaksiyada yozilishi kerak"
date: "2026-10-06"
excerpt: "Bazaga yozish va brokerga xabar yuborish ikki alohida amal, ularni hech qanday tartibda ishonchli bog'lab bo'lmaydi. Outbox bu muammoni qanday yechadi, relay qanday yoziladi va pattern qachon ortiqcha."
tags:
  - architecture
  - postgresql
  - distributed-systems
  - kafka
---

Buyurtma bazaga yoziladi, keyin "buyurtma berildi" voqeasi Kafka'ga yuboriladi. Ikki amal, ikki tizim va ularni birlashtiruvchi tranzaksiya yo'q. Ularni qaysi tartibda bajarmang, har birida ma'lumot buziladigan holat bor:

| Tartib | Qayerda uziladi | Natija |
| --- | --- | --- |
| Avval commit, keyin publish | Publish xato berdi yoki jarayon o'chdi | Buyurtma bor, voqea yo'q: ombor hech qachon bilmaydi |
| Avval publish, keyin commit | Commit rollback bo'ldi | Voqea bor, buyurtma yo'q: ombor arvoh buyurtmani yig'adi |
| Tranzaksiya ichida publish | Iste'molchi commit'dan oldin o'qidi | Voqea keldi, bazada esa qator hali ko'rinmaydi |

Bu muammo dual write deb ataladi va uni retry bilan yechib bo'lmaydi: jarayon ikki amal orasida o'chsa, retry qiladigan hech kim qolmaydi.

## Nima u

Outbox g'oyasi oddiy: xabar brokerga emas, o'sha bazadagi jadvalga, biznes ma'lumoti bilan bitta tranzaksiyada yoziladi. Brokerga yetkazishni esa alohida jarayon, relay bajaradi.

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

Endi buyurtma va voqea yoki birga mavjud, yoki birga yo'q. Uchinchi holat bo'lmaydi, chunki bu Postgres'ning oddiy tranzaksiyasi.

## Relay

Relay yuborilmagan qatorlarni oladi, brokerga jo'natadi va belgilaydi. Bir nechta relay parallel ishlashi uchun qatorlar `FOR UPDATE SKIP LOCKED` bilan olinadi:

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

Ikki relay bir vaqtda ishga tushganda nima bo'ladi:

```text
SKIP LOCKED bilan:   relay-1: 1, 2, 3     relay-2: 4, 5, 6   (bir vaqtda)
SKIP LOCKED'siz:     relay-1: 1, 2, 3     relay-2: relay-1 tugashini 2.1 s kutdi
```

## Nega `id` bo'yicha o'qib bo'lmaydi

Oxirgi o'qilgan `id` ni eslab, keyingi safar `WHERE id > $last` deb o'qish tabiiy tuyuladi. Lekin `id` qator qo'shilgan paytda beriladi, qator esa faqat commit bo'lganda ko'rinadi:

```text
tx A: id 7 oldi, hali commit qilmagan
tx B: id 8 oldi, commit qildi
relay: id > 6  ->  8        kursor = 8
tx A: commit qildi
relay: id > 8  ->  (bo'sh)
hech qachon yuborilmaydi: 7
```

7-xabar hech qachon yuborilmaydi va buni hech kim sezmaydi. `published_at IS NULL` sharti bu xatodan xoli: kechikib commit bo'lgan qator keyingi aylanishda baribir topiladi.

## Kamida bir marta

Relay xabarni yuborib, `COMMIT` dan oldin o'chsa, qatorlar belgilanmay qoladi va xabar qayta yuboriladi. Outbox xabar yo'qolmasligini kafolatlaydi, lekin u bir martadan ko'p kelishi mumkin. Shuning uchun iste'molchi `message-id` bo'yicha takrorni o'zi aniqlaydi va buni ta'sirning o'zi bilan bitta tranzaksiyada qiladi:

```sql
BEGIN;
INSERT INTO processed_messages (message_id) VALUES (7) ON CONFLICT DO NOTHING;
-- INSERT 0 1: birinchi marta, ishlov beriladi
-- INSERT 0 0: takror, tranzaksiya hech narsa qilmay yopiladi
UPDATE stock SET reserved = reserved + 1 WHERE item = 'coffee';
COMMIT;
```

Yana ikki qoida. Bir nechta relay bo'lsa, bitta buyurtma voqealarining tartibi kafolatlanmaydi, tartib muhim bo'lsa relay bitta bo'ladi. Yuborilgan qatorlar esa vaqti-vaqti bilan o'chiriladi, aks holda outbox cheksiz o'sadi. Polling o'rniga WAL'ni o'qish ham mumkin (Debezium): kechikish kamroq, lekin infratuzilma og'irroq.

## Qachon kerak

| Vaziyat | Outbox |
| --- | --- |
| Bazadagi o'zgarishdan keyin Kafka yoki RabbitMQ'ga voqea ketishi shart | Kerak |
| O'zgarishdan keyin boshqa servisga webhook yoki email yuborilishi shart | Kerak |
| Iste'molchi shu Postgres'ning o'zidan o'qiydi | Kerak emas: navbatning o'zini bazada saqlang ([PGMQ](/blog/postgres-queue-in-your-transaction)) |
| Voqea yo'qolsa zarar yo'q (analitika, log) | Kerak emas |
| Bitta servis, tashqi tizimga ta'sir yo'q | Kerak emas |

Qoida bitta: bazadagi o'zgarish boshqa tizimda albatta aks etishi kerak bo'lsa, ikkalasini bitta tranzaksiyada yozing va yetkazishni relay'ga topshiring.
