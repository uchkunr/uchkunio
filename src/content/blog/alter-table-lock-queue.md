---
title: "ALTER TABLE lock navbati: migratsiya production'ni qanday to'xtatadi"
date: "2026-09-08"
excerpt: "Ustun qo'shish bir zumda bajariladi, lekin lock kutayotgan ALTER TABLE ortida jadvalga kelgan har bir so'rov to'xtab qoladi. Lock navbati qanday ishlaydi va lock_timeout nega har bir migratsiyada bo'lishi shart."
tags:
  - postgresql
  - migrations
  - reliability
---

`ALTER TABLE orders ADD COLUMN note text` Postgres 11 dan beri bir zumda bajariladi: jadval qayta yozilmaydi, faqat katalog o'zgaradi. Shunga qaramay, aynan shu buyruq production'ni bir necha soniyaga to'xtatib qo'yishi mumkin. Sabab buyruqning o'zida emas, u kutadigan lock'da.

## Lock navbati

Har bir so'rov jadvalga lock oladi. `SELECT` eng yengil `AccessShareLock` ni oladi va boshqa `SELECT`'lar bilan bemalol yonma-yon ishlaydi. `ALTER TABLE` esa `AccessExclusiveLock` talab qiladi, u hech qanday boshqa lock bilan sig'maydi. Hal qiluvchi tafsilot shundaki, Postgres'da lock'lar navbat bilan beriladi: keyin kelgan so'rov navbatda turgan og'ir lock'ni chetlab o'tmaydi.

Buni uch sessiya bilan tekshiramiz. A uzoq tranzaksiya ichida jadvalni o'qiydi, B ustun qo'shadi, C esa oddiy `SELECT` yuboradi:

```sql
-- A: tranzaksiya 6 soniya ochiq turadi
BEGIN; SELECT count(*) FROM orders;
-- B: bir soniyadan keyin
ALTER TABLE orders ADD COLUMN note text;
-- C: yana bir soniyadan keyin
SELECT count(*) FROM orders;
```

```text
 pid | query                           | wait    | blocked_by
-----+---------------------------------+---------+------------
 116 | BEGIN; SELECT count(*) FROM ... | Timeout | {}
 123 | ALTER TABLE orders ADD COLUMN.. | Lock    | {116}
 130 | SELECT count(*) FROM orders;    | Lock    | {123}
```

C'ni A emas, B bloklayapti: `blocked_by` ustunida ALTER'ning pid'i turibdi. A va C bir-biriga xalaqit bermasdi, lekin ular o'rtasida navbatda ALTER turibdi va shu soniyalarda jadvalga kelgan har bir so'rov uning ortiga qo'shiladi.

![A uzoq SELECT lock'ni ushlab turadi, ALTER TABLE uni kutadi, har bir yangi so'rov esa ALTER ortida navbatga turadi](/sketches/alter/lock-queue.svg)

```text
B ALTER:  5.08 s kutdi, so'ng bir zumda bajarildi
C SELECT: 4.09 s kutdi
```

Real trafikda C bitta emas: soniyasiga yuzlab so'rov navbatga tushadi, connection pool to'lib qoladi va servis tashqaridan butunlay ishlamay qolgandek ko'rinadi.

## lock_timeout

Yechim: migratsiya lock'ni cheksiz kutmasligi kerak.

```sql
SET lock_timeout = '1s';
ALTER TABLE orders ADD COLUMN note text;
```

```text
B ALTER:  1.09 s  ERROR:  canceling statement due to lock timeout
C SELECT: 0.09 s
```

ALTER bir soniyadan so'ng voz kechadi va navbat darhol tarqaladi. Migratsiya muvaffaqiyatsiz tugadi, lekin bu servis to'xtashidan beqiyos arzon: uni qayta urinish bilan tinchroq paytda bajarish mumkin.

![SELECT ALTER TABLE ortida lock_timeout'siz 4.09 s, lock_timeout = 1s bilan 0.09 s kutdi](/sketches/alter/wait-race.svg)

```bash
for attempt in 1 2 3 4 5; do
  psql -v ON_ERROR_STOP=1 -c "SET lock_timeout = '1s'; ALTER TABLE orders ADD COLUMN note text;" && break
  sleep $((attempt * 2))
done
```

## Migratsiya qoidalari

- Har bir migratsiya `SET lock_timeout` bilan boshlanadi. ORM migratsiyalarida ham shunday: SQL faylning birinchi qatoriga yozish yetarli.
- Uzoq tranzaksiyalar migratsiyadan oldin topiladi: `SELECT pid, now() - xact_start AS age, query FROM pg_stat_activity WHERE xact_start < now() - interval '1 minute';`
- Jadvalni qayta yozadigan o'zgarishlar bir zumda bajarilmaydi: `ALTER COLUMN ... TYPE` yoki `gen_random_uuid()` kabi VOLATILE standart qiymatli ustun. Ular yangi ustun qo'shish va ma'lumotni qismlab ko'chirish orqali bajariladi.
- Indeks `CREATE INDEX CONCURRENTLY` bilan quriladi, u jadvalga yozishni bloklamaydi.
