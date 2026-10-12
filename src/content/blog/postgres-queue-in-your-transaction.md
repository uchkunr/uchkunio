---
title: "Postgres'da navbat: xabarni ma'lumot bilan bitta tranzaksiyada yuborish"
date: "2026-08-04"
excerpt: "Bazaga yozilgan qator va u haqidagi xabar alohida tizimlarda saqlansa, ular bir-biridan ajralib qolishi mumkin. PGMQ bilan ikkalasi bitta tranzaksiyaga sig'adi, pgmq-ts esa shu imkoniyatni saqlab qolish uchun yozildi."
tags:
  - postgresql
  - bun
  - typescript
  - open-source
---

Buyurtma qabul qilinganda odatda ikki ish bajariladi: buyurtma bazaga yoziladi va u haqidagi xabar boshqa xizmatlar uchun navbatga yuboriladi.

```ts
const [order] = await sql`INSERT INTO orders (item) VALUES (${"coffee"}) RETURNING id`;
await producer.send({ topic: "orders", messages: [{ value: order.id }] });
```

Bu ikki satr ikki xil tizimga murojaat qiladi va ularni birlashtiruvchi tranzaksiya yo'q. Birinchi satrdan keyin jarayon to'xtasa, buyurtma bazada qoladi, xabar esa hech qachon yuborilmaydi.

[PGMQ](https://github.com/pgmq/pgmq) navbatni Postgres ichida oddiy jadval sifatida saqlaydi. Shu sababli xabar yuborish ham bazaga yozishning o'zi bo'lib, buyurtma bilan bitta tranzaksiyaga kiradi:

```ts
await sql.begin(async (tx) => {
  const [order] = await tx`INSERT INTO orders (item) VALUES (${"coffee"}) RETURNING id`;
  await orderEvents.with(tx).send({ orderId: order.id });
});
```

Tranzaksiya ichida xato yuz bersa, na buyurtma, na xabar saqlanadi. Commit bo'lmaguncha esa xabarni boshqa o'quvchilar ko'rmaydi.

## Ulanishni kutubxona boshqarmaydi

Bu imkoniyat saqlanib qolishi uchun [pgmq-ts](https://github.com/uchkunr/pgmq-ts) ulanish ochmaydi va tranzaksiyani o'zi boshlamaydi. U so'rovni bajara oladigan istalgan obyektni qabul qiladi:

```ts
export interface Executor {
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown>;
}
```

Bun'dagi klient, tranzaksiya, savepoint va ajratilgan ulanish shu interfeysga mos keladi. Natijada bitta navbat bilan ularning har birida ishlash mumkin:

```ts
const orders = new Pgmq(sql).queue("orders");

await orders.send(msg);                             // pool orqali
await sql.begin((tx) => orders.with(tx).send(msg)); // tranzaksiya ichida

const conn = await sql.reserve();
await orders.with(conn).send(msg);                  // ajratilgan ulanishda
conn.release();
```

## Bun bilan to'rt kutilmagan holat

Har bir taxminni hujjatga emas, ishlab turgan bazaga tayanib tekshirdim. Dastlabki uchtasining natijalari Bun 1.4.2 va Postgres 18 da olingan.

Matn ko'rinishidagi JSON `jsonb` parametriga berilsa, Bun uni yana bir bor satrga o'raydi va bazaga obyekt emas, satr yoziladi. Shuning uchun kutubxona JSON'ni har doim `::text::jsonb` orqali uzatadi, bunda matnni Postgres'ning o'zi tahlil qiladi:

```ts
const json = JSON.stringify({ a: 1 });

await sql`SELECT jsonb_typeof(${json}::jsonb) AS t`;       // [{ t: "string" }]
await sql`SELECT jsonb_typeof(${json}::text::jsonb) AS t`; // [{ t: "object" }]

await sql`SELECT ${"{bad"}::jsonb`;       // "{bad" satri sifatida qabul qilinadi
await sql`SELECT ${"{bad"}::text::jsonb`; // invalid input syntax for type json
```

Bun `int8` ustunini standart holatda satr ko'rinishida qaytaradi, uni oddiy songa aylantirish esa aniqlikni yo'qotadi. Kutubxona har bir `bigint` ustunni `::text` qilib oladi va o'zi `BigInt()` ga o'giradi:

```ts
await sql`SELECT 9007199254740993::int8 AS n`; // [{ n: "9007199254740993" }]
Number("9007199254740993");                    // 9007199254740992
BigInt("9007199254740993");                    // 9007199254740993n
```

`query.cancel()` chaqirilgani bilan bazadagi so'rov to'xtamaydi:

```ts
const q = sql`SELECT pg_sleep(3)`;
setTimeout(() => q.cancel(), 100);
await q; // 3005 ms dan keyin muvaffaqiyatli tugadi
```

Shu sababli `readWithPoll` PGMQ'ning `read_with_poll` funksiyasiga tayanmaydi. Uning o'rnida oddiy `read` va bekor qilinadigan `setTimeout` asosidagi sikl ishlaydi, natijada to'xtatish taxminan 2 millisekundda amalga oshadi.

To'rtinchisi eng jiddiysi bo'ldi: Bun 1.2.0 pool orqali bir vaqtda yuborilgan ikkita `delete` dan birini jimgina tashlab yuborar, bu esa 20 urinishdan 11 tasida takrorlandi. Xato 1.2.23 da tuzatilgan, shu bois `engines.bun` aynan shu versiyadan boshlanadi.

## Xabar JavaScript'dan o'tmasligi kerak

Worker xabarni belgilangan urinishlar ichida ishlay olmasa, uni dead-letter navbatiga ko'chiradi. Xabarni JavaScript'da o'qib, qayta yuborish oson, biroq katta sonlar bu yo'lda o'zgarib ketadi:

```ts
JSON.parse('{"n":12345678901234567891}').n; // 12345678901234567000
```

Shuning uchun nusxa to'liq SQL ichida olinadi va asl xabarni o'chirish bilan birga bitta tranzaksiyada bajariladi:

```ts
db`
  SELECT sent.msg_id::text AS msg_id
  FROM pgmq.set_vt(${queue}::text, ${msgId}::text::bigint, ${vt}::int) AS m
  CROSS JOIN LATERAL pgmq.send(${target}::text, m.message, m.headers, ${0}::int) AS sent(msg_id)`;
```

## Misollar test vazifasini bajaradi

`examples/` papkasidagi har bir fayl o'z da'vosini `assert` bilan tekshiradi:

```ts
// examples/transactional-send.ts: ROLLBACK dan keyin ham bitta buyurtma va bitta xabar
assert.equal(await countOrders(), 1);
assert.equal((await events.metrics()).queueLength, 1n);
```

CI bu misollarni PGMQ 1.10 va 1.13, Bun 1.2.23 va eng so'nggi versiyada ishga tushiradi. Har bir qaror va uning bahosi [DECISIONS.md](https://github.com/uchkunr/pgmq-ts/blob/main/DECISIONS.md) da batafsil yozilgan.
