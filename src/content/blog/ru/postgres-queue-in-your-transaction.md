---
title: "Очередь в Postgres: отправка сообщения в одной транзакции с данными"
date: "2026-08-04"
excerpt: "Если строка в базе и сообщение о ней хранятся в разных системах, они могут разойтись. С PGMQ и то и другое помещается в одну транзакцию, а pgmq-ts написан для того, чтобы эту возможность сохранить."
tags:
  - postgresql
  - bun
  - typescript
  - open-source
---

Когда приходит заказ, обычно происходят две вещи: заказ записывается в базу, а сообщение о нём отправляется в очередь для других сервисов.

```ts
const [order] = await sql`INSERT INTO orders (item) VALUES (${"coffee"}) RETURNING id`;
await producer.send({ topic: "orders", messages: [{ value: order.id }] });
```

Эти две строки обращаются к двум разным системам, и транзакции, которая бы их объединяла, нет. Если процесс остановится после первой строки, заказ останется в базе, а сообщение не будет отправлено никогда.

[PGMQ](https://github.com/pgmq/pgmq) хранит очередь внутри Postgres в виде обычной таблицы. Поэтому отправка сообщения тоже оказывается просто записью в базу и попадает в одну транзакцию с заказом:

```ts
await sql.begin(async (tx) => {
  const [order] = await tx`INSERT INTO orders (item) VALUES (${"coffee"}) RETURNING id`;
  await orderEvents.with(tx).send({ orderId: order.id });
});
```

Если внутри транзакции произойдёт ошибка, не сохранится ни заказ, ни сообщение. А до коммита сообщение не видно другим читателям.

![При двух системах сообщение теряется, если процесс падает; в одной транзакции Postgres строка и сообщение фиксируются вместе](/sketches/pgmq/dual-write.svg)

![Транзакция с ошибкой не оставляет ни заказа, ни сообщения; та же транзакция без ошибки сохраняет оба](/media/pgmq-ts-demo.gif)

## Соединениями управляет не библиотека

Чтобы эта возможность сохранилась, [pgmq-ts](https://github.com/uchkunr/pgmq-ts) не открывает соединения и не начинает транзакции сам. Он принимает любой объект, который умеет выполнить запрос:

```ts
export interface Executor {
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown>;
}
```

Этому интерфейсу соответствуют клиент Bun, транзакция, savepoint и выделенное соединение. В результате с одной и той же очередью можно работать через любой из них:

```ts
const orders = new Pgmq(sql).queue("orders");

await orders.send(msg);                             // через пул
await sql.begin((tx) => orders.with(tx).send(msg)); // внутри транзакции

const conn = await sql.reserve();
await orders.with(conn).send(msg);                  // на выделенном соединении
conn.release();
```

## Четыре неожиданности с Bun

Каждое предположение я проверял не по документации, а на работающей базе. Результаты первых трёх получены на Bun 1.4.2 и Postgres 18.

Если передать JSON в виде текста в параметр типа `jsonb`, Bun ещё раз оборачивает его в строку, и в базу записывается не объект, а строка. Поэтому библиотека всегда передаёт JSON через `::text::jsonb`, и тогда текст разбирает сам Postgres:

```ts
const json = JSON.stringify({ a: 1 });

await sql`SELECT jsonb_typeof(${json}::jsonb) AS t`;       // [{ t: "string" }]
await sql`SELECT jsonb_typeof(${json}::text::jsonb) AS t`; // [{ t: "object" }]

await sql`SELECT ${"{bad"}::jsonb`;       // принимается как строка "{bad"
await sql`SELECT ${"{bad"}::text::jsonb`; // invalid input syntax for type json
```

По умолчанию Bun возвращает столбец `int8` в виде строки, а её преобразование в обычное число теряет точность. Библиотека получает каждый столбец `bigint` через `::text` и сама переводит его в `BigInt()`:

```ts
await sql`SELECT 9007199254740993::int8 AS n`; // [{ n: "9007199254740993" }]
Number("9007199254740993");                    // 9007199254740992
BigInt("9007199254740993");                    // 9007199254740993n
```

Вызов `query.cancel()` не останавливает запрос в базе:

```ts
const q = sql`SELECT pg_sleep(3)`;
setTimeout(() => q.cancel(), 100);
await q; // успешно завершился через 3005 ms
```

Поэтому `readWithPoll` не опирается на функцию `read_with_poll` из PGMQ. Вместо неё работает цикл на основе обычного `read` и отменяемого `setTimeout`, и в результате остановка занимает примерно 2 миллисекунды.

Четвёртая неожиданность оказалась самой серьёзной: Bun 1.2.0 молча терял один из двух `delete`, одновременно отправленных через пул, и это воспроизводилось в 11 попытках из 20. Ошибку исправили в 1.2.23, поэтому `engines.bun` начинается именно с этой версии.

## Сообщение не должно проходить через JavaScript

Если worker не может обработать сообщение за отведённое число попыток, он переносит его в dead-letter очередь. Прочитать сообщение в JavaScript и отправить заново просто, но большие числа по дороге искажаются:

```ts
JSON.parse('{"n":12345678901234567891}').n; // 12345678901234567000
```

Поэтому копия создаётся целиком внутри SQL и выполняется в одной транзакции с удалением исходного сообщения:

```ts
db`
  SELECT sent.msg_id::text AS msg_id
  FROM pgmq.set_vt(${queue}::text, ${msgId}::text::bigint, ${vt}::int) AS m
  CROSS JOIN LATERAL pgmq.send(${target}::text, m.message, m.headers, ${0}::int) AS sent(msg_id)`;
```

## Примеры служат тестами

Каждый файл в папке `examples/` проверяет своё утверждение через `assert`:

```ts
// examples/transactional-send.ts: и после ROLLBACK по-прежнему один заказ и одно сообщение
assert.equal(await countOrders(), 1);
assert.equal((await events.metrics()).queueLength, 1n);
```

CI запускает эти примеры на PGMQ 1.10 и 1.13, на Bun 1.2.23 и на последней версии. Каждое решение и его цена подробно описаны в [DECISIONS.md](https://github.com/uchkunr/pgmq-ts/blob/main/DECISIONS.md).
