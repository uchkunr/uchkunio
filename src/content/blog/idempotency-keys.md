---
title: "Idempotency key: qayta urinishda to'lovni ikki marta yechmaslik"
date: "2026-09-29"
excerpt: "Tarmoq javobni yo'qotsa, mijoz so'rovni qayta yuboradi va pul ikki marta yechiladi. Idempotency key bilan bir vaqtda kelgan beshta qayta urinish bitta to'lovga aylanadi."
tags:
  - api-design
  - postgresql
  - payments
  - distributed-systems
---

Mijoz `POST /charge` yuboradi, server pulni yechadi, lekin javob yo'lda yo'qoladi: timeout tugadi, mobil tarmoq uzildi yoki load balancer ulanishni yopdi. Mijoz to'lov o'tgan-o'tmaganini bilmaydi va qayta urinadi. Kalitsiz har bir urinish yangi to'lov:

```text
without a key: 5 retries -> 5 payments
```

## Kalit so'rov bilan birga keladi

Mijoz har bir mantiqiy amal uchun bitta kalit yaratadi va barcha qayta urinishlarda uni o'zgartirmaydi:

```http
POST /charge
Idempotency-Key: 7b3e-checkout-A-1001
Content-Type: application/json

{"orderId": "A-1001", "amount": "49.90"}
```

Server kalitni javob bilan birga saqlaydi. Takror kelgan so'rov qayta bajarilmaydi, u saqlangan javobni oladi.

```sql
CREATE TABLE idempotency_keys (
  key          text PRIMARY KEY,
  request_hash text NOT NULL,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

![Bir xil kalitli beshta qayta urinish API'ga yetadi: biri pul yechadi, to'rttasi saqlangan javobni oladi](/sketches/idempotency/retries.svg)

## Bir vaqtda kelgan urinishlar

Eng xavfli holat: ikki urinish bir vaqtda keladi. "Avval tekshir, keyin yoz" yondashuvi bu yerda ishlamaydi, chunki ikkalasi ham kalitni topmay qoladi. Kalitni egallashni bazaning unique indeksiga topshiramiz:

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

Ikkinchi `INSERT` birinchisining tranzaksiyasi tugashini kutadi, unique indeks aynan shunday ishlaydi. Birinchisi commit bo'lgach, `ON CONFLICT DO NOTHING` hech narsa qaytarmaydi va ikkinchi so'rov tayyor javobni o'qiydi. Bir xil kalit bilan bir vaqtda yuborilgan beshta so'rov:

```text
201 {"paymentId":"1"}
200 {"paymentId":"1"} (replayed)
200 {"paymentId":"1"} (replayed)
200 {"paymentId":"1"} (replayed)
200 {"paymentId":"1"} (replayed)
with a key: 5 retries -> 1 payment
```

![Birinchi so'rov kalitni egallab, pul yechadi; xuddi shu kalitli qayta urinish saqlangan javobni oladi](/sketches/idempotency/flow.svg)

## Uch qoida

Birinchisi, `request_hash` bir kalitni boshqa so'rov uchun ishlatishdan himoya qiladi:

```text
{"status":422,"body":{"error":"key reused with a different request"}}
```

Ikkinchisi, to'lov provayderi ham o'sha kalitni olishi kerak. Stripe kabi provayderlar `Idempotency-Key` header'ini qabul qiladi: server provayderga so'rov yuborib, javobni saqlashga ulgurmay o'chsa, keyingi urinish provayder tomonida ham pulni qayta yechmaydi. Bu yerdagi misolda provayder chaqiruvi soddalashtirilgan: haqiqiy tizimda uzoq tashqi chaqiruv baza tranzaksiyasi ichida emas, `processing` va `done` holatlari orqali boshqariladi.

Uchinchisi, kalitlar abadiy saqlanmaydi, odatda bir sutka yetarli:

```sql
DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours';
```
