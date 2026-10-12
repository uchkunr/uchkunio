---
title: "Keyset pagination: OFFSET'dan 1800 barobar tezroq sahifalash"
date: "2026-09-15"
excerpt: "OFFSET bilan har bir keyingi sahifa oldingisidan sekinroq, chunki Postgres tashlab yuboriladigan qatorlarni ham o'qiydi. Keyset pagination 49 501-sahifani ham birinchisi kabi tez qaytaradi."
tags:
  - postgresql
  - performance
  - api-design
---

Ko'p API sahifalashni shunday yozadi:

```sql
SELECT id, created_at FROM events
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 990000;
```

Birinchi sahifalar tez ochiladi, shuning uchun muammo testda ko'rinmaydi. 1 million qatorli jadvalda, `(created_at, id)` indeksi bilan:

```text
OFFSET 0:       0.041 ms
OFFSET 100000:  8.653 ms
OFFSET 990000: 84.783 ms
```

Vaqt sahifa raqami bilan chiziqli o'sadi. Sababini reja ko'rsatadi:

```text
Limit (actual rows=20)
  ->  Index Only Scan using events_created_idx on events (actual rows=990020)
```

Postgres 20 ta qator qaytarish uchun indeksdan 990 020 ta yozuvni o'qiydi va ulardan 990 000 tasini tashlab yuboradi. OFFSET qayerdan boshlashni bilmaydi, u faqat nechta yozuvni o'tkazib yuborishni biladi.

![OFFSET 20 ta qator uchun 990 020 ta indeks yozuvini o'qiydi, keyset esa kursorga sakrab, 20 tasini o'qiydi](/sketches/keyset/offset-vs-keyset.svg)

## Oxirgi ko'rilgan qatordan davom etish

Keyset pagination'da sahifa raqami o'rniga oldingi sahifaning oxirgi qatori eslab qolinadi va keyingi so'rov aynan undan boshlanadi:

```sql
SELECT id, created_at FROM events
WHERE (created_at, id) < ('2026-01-01 02:46:41+00', 10001)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

```text
Index Only Scan using events_created_idx on events (actual rows=20)
  Index Cond: (ROW(created_at, id) < ROW('2026-01-01 02:46:41+00', 10001))
Execution Time: 0.047 ms
```

Postgres indeksda kursorga to'g'ridan-to'g'ri sakraydi va faqat 20 ta yozuvni o'qiydi. Natija OFFSET 990000 bilan aynan bir xil qatorlar, lekin 1800 barobar tezroq.

![1 million qatorli jadvalning 49 501-sahifasi: OFFSET 84.8 ms, keyset 0.047 ms](/sketches/keyset/race.svg)

Ikki tafsilot hal qiluvchi. Birinchisi, `id` tartibga qo'shiladi: bir xil `created_at` li qatorlar bo'lsa, tartib noaniq bo'lib qoladi va qatorlar ikki sahifada takrorlanadi yoki umuman tushib qoladi. Ikkinchisi, `(created_at, id) < (...)` qator taqqoslashi indeks tartibiga to'liq mos keladi, shuning uchun Postgres uni bitta `Index Cond` sifatida ishlatadi. Uni `created_at < $1 OR (created_at = $1 AND id < $2)` deb yozish mantiqan bir xil, lekin bitta indeks qidiruviga aylanmasligi mumkin.

## API'da

Kursor mijozga ichini ochib ko'rish shart bo'lmagan satr sifatida beriladi:

```ts
const encode = (row: { created_at: Date; id: string }) =>
  Buffer.from(`${row.created_at.toISOString()}|${row.id}`).toString("base64url");

const decode = (cursor: string) => {
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString().split("|");
  return { createdAt, id };
};
```

```json
{ "items": [], "next": "MjAyNi0wMS0wMVQwMjo0Njo0MS4wMDBafDEwMDAx" }
```

Keyset'ning cheklovi bitta: to'g'ridan-to'g'ri 37-sahifaga sakrab bo'lmaydi, faqat oldinga yoki orqaga yurish mumkin. Cheksiz lenta, ochiq API va eksport uchun bu to'g'ri tanlov. Sahifa raqamli admin jadvallari uchun esa kichik jadvallarda OFFSET yetarli.
