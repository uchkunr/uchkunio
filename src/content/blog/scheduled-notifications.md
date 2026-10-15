---
title: "Belgilangan vaqtda notification yuborish"
date: "2026-10-14"
excerpt: "Har daqiqada ishlaydigan cron 1 mln dori ichidan bir daqiqalik eslatmalarni topish uchun har safar 130 ms dan ortiq vaqt sarflardi, deploy paytida o'tkazib yuborilgan daqiqa esa eslatmani butunlay yo'qotardi. BullMQ job scheduler bilan bazaga takroriy so'rov yo'qoldi, worker 30 soniya o'chiq turgan paytda vaqti kelgan 1000 ta eslatmaning birortasi ham yo'qolmadi."
tags:
  - bullmq
  - redis
  - postgresql
  - nodejs
  - scheduling
---

Foydalanuvchilar har kuni ma'lum vaqtda dori ichadi: Sitramon 18:00 da, Amoxicillin ertalab 09:00 da va hokazo. Har bir foydalanuvchi buni o'z timezone'ida qiladi: Toshkentdagi 18:00 bilan Berlindagi 18:00 ikki xil lahza. Tizim esa dori vaqtidan 5 daqiqa o'tib, ya'ni 18:05 da, notification yuborishi kerak.

Dorilar foydalanuvchi id'si bilan `pills` jadvalida saqlanadi, vaqt esa foydalanuvchining mahalliy vaqtida yoziladi:

```sql
CREATE TABLE users (
  id       bigint PRIMARY KEY,
  timezone text   NOT NULL            -- IANA: Asia/Tashkent, Europe/Berlin, ...
);

CREATE TABLE pills (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users,
  name    text   NOT NULL,
  take_at time   NOT NULL             -- foydalanuvchining mahalliy vaqti
);

CREATE TABLE notifications (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pill_id    bigint      NOT NULL REFERENCES pills,
  user_id    bigint      NOT NULL,
  due_at     timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pill_id, due_at)
);
```

## Birinchi versiya: har daqiqada cron

Birinchi versiyada cron har daqiqada bitta route'ni chaqirardi. Route `pills` jadvalidan aynan shu daqiqada eslatilishi kerak bo'lgan dorilarni topadi, ularni `notifications` jadvaliga yozadi va yuboradi:

```sql
INSERT INTO notifications (pill_id, user_id, due_at)
SELECT p.id, p.user_id, date_trunc('minute', now())
FROM pills p JOIN users u ON u.id = p.user_id
WHERE p.take_at + interval '5 minutes' = date_trunc('minute', now() AT TIME ZONE u.timezone)::time
ON CONFLICT DO NOTHING
RETURNING pill_id, user_id;
```

Bu yechimning birinchi muammosi resurs. Shart har bir qatorda foydalanuvchining timezone'iga bog'liq, shuning uchun `take_at` bo'yicha indeks ishlatilmaydi va Postgres har safar ikkala jadvalni to'liq o'qiydi. 50 ming foydalanuvchi va 100 ming dorida (qisqartirilgan):

```text
Hash Join (actual time=15.278..26.014 rows=81.00 loops=1)
  ->  Seq Scan on pills p (actual time=0.006..3.522 rows=100000.00 loops=1)
  ->  Hash (actual time=14.889..14.890 rows=50000.00 loops=1)
        ->  Seq Scan on users u (actual time=0.004..1.872 rows=50000.00 loops=1)
Execution Time: 26.073 ms
```

81 ta eslatmani topish uchun 150 ming qator o'qildi. Bu sutkasiga 1440 marta takrorlanadi. Ma'lumot 10 barobar ko'payganda, ya'ni 1 mln dorida, bitta ishga tushish 131 ms dan 141 ms gacha vaqt oldi va Postgres unga ikkita parallel worker qo'shdi. Natijada eslatma bo'lmagan daqiqada ham baza butun jadvalni o'qiydi.

Ikkinchi muammo jiddiyroq. So'rov faqat joriy daqiqani tekshiradi. Deploy paytida route 18:05 da javob bermasa, o'sha daqiqaning eslatmalari keyingi ishga tushishda ham topilmaydi. Toshkentdagi foydalanuvchi va uning 18:00 dagi Sitramoni uchun route'ni 18:04, 18:06 va 18:07 da ishga tushirdim, 18:05 esa deploy'ga to'g'ri keldi:

```text
pill 1000001, user 8 (Asia/Tashkent), take_at 18:00
cron at 2026-10-15 18:04:00+05:
  for user 8: 0
cron at 2026-10-15 18:06:00+05:
  for user 8: 0
cron at 2026-10-15 18:07:00+05:
  for user 8: 0
notifications for the 18:00 Sitramon of user 8: 0
```

Xuddi shu so'rov 18:05 da bu dorini topadi:

```text
cron at 18:05: 1 notification(s) for user 8
```

Lekin bu ishga tushish o'tkazib yuborildi va foydalanuvchi eslatmani olmadi. Bunday xatoni hech kim sezmaydi: log'da xato yo'q, notification esa shunchaki kelmaydi.

## Ikkinchi versiya: BullMQ'da delayed job

Ikkinchi versiyada men har daqiqada tekshiradigan cron'ni olib tashladim. Endi "hozir kimga eslatish kerak?" deb har daqiqada so'ralmaydi. Buning o'rniga har bir dori Redis'ga o'zi qachon eslatilishi kerakligini aytadi, worker esa aynan o'sha paytda uyg'onadi. BullMQ'da buning uchun job scheduler bor: har bir dori uchun cron pattern va foydalanuvchining timezone'i bilan bitta scheduler.

```ts
import { Queue } from "bullmq";

const reminders = new Queue("pill-reminders", { connection });

/** 18:00 da ichiladigan dori 18:05 da, foydalanuvchining o'z vaqtida eslatiladi. */
export function reminderPattern(takeAt: string): string {
  const [h, m] = takeAt.split(":").map(Number);
  const minutes = (h * 60 + m + 5) % (24 * 60);
  return `${minutes % 60} ${Math.floor(minutes / 60)} * * *`;
}

export async function schedulePill(pill: { id: number; takeAt: string }, timezone: string) {
  await reminders.upsertJobScheduler(
    `pill-${pill.id}`,
    { pattern: reminderPattern(pill.takeAt), tz: timezone },
    { name: "remind", data: { pillId: pill.id } },
  );
}

export async function unschedulePill(pillId: number) {
  await reminders.removeJobScheduler(`pill-${pillId}`);
}
```

`schedulePill` dori qo'shilganda yoki vaqti o'zgarganda, shuningdek foydalanuvchi timezone'ini almashtirganda chaqiriladi. `upsertJobScheduler` bir xil id bilan eski jadvalni almashtiradi, shuning uchun uni qayta chaqirish xavfsiz. Dori o'chirilganda esa `unschedulePill` chaqiriladi.

Scheduler'ning o'zi ish bajarmaydi. U Redis'da keyingi eslatma uchun bitta delayed job saqlaydi, ya'ni vaqt bo'yicha tartiblangan to'plamdagi bitta yozuvni. Vaqti kelganda worker uni oladi, BullMQ esa shu zahoti keyingi job'ni yaratadi. Buni ko'rish uchun har 2 soniyada ishlaydigan scheduler yaratib, job'larni chop etdim (qisqartirilgan):

```text
{"id":"repeat:pill-1:1792042950000", ..., "processedOn":1792042950089, ..., "opts":{..., "prevMillis":1792042950000, ...}}
{"id":"repeat:pill-1:1792042952000","timestamp":1792042950091, ...}
```

Ikkinchi job birinchisi ishga tushgandan 2 ms keyin yaratilgan, ya'ni har bir dori uchun Redis'da bir vaqtda faqat bitta kutayotgan job bo'ladi. `prevMillis` esa job qaysi lahza uchun rejalashtirilganini saqlaydi. Worker shu `prevMillis`ni `due_at` sifatida yozadi, `UNIQUE (pill_id, due_at)` esa bitta eslatmani ikki marta yuborishga yo'l qo'ymaydi:

```ts
import { Worker } from "bullmq";

new Worker(
  "pill-reminders",
  async (job) => {
    const dueAt = job.opts.prevMillis!; // bu job rejalashtirilgan lahza
    const { rows } = await pool.query(
      `INSERT INTO notifications (pill_id, user_id, due_at)
       SELECT id, user_id, to_timestamp($2 / 1000.0) FROM pills WHERE id = $1
       ON CONFLICT (pill_id, due_at) DO NOTHING
       RETURNING user_id`,
      [job.data.pillId, dueAt],
    );
    if (rows.length > 0) await sendPush(rows[0].user_id, job.data.pillId);
  },
  { connection: { ...connection, maxRetriesPerRequest: null }, concurrency: 50 },
);
```

Timezone'ni hisoblash ham BullMQ zimmasida. 25-oktabrda Berlin yozgi vaqtdan chiqadi, Toshkentda esa bunday o'tish yo'q:

```text
Europe/Berlin  18:05 local, first run after 2026-10-24: 2026-10-24T16:05Z
Asia/Tashkent  18:05 local, first run after 2026-10-24: 2026-10-24T13:05Z
Europe/Berlin  18:05 local, first run after 2026-10-26: 2026-10-26T17:05Z
Asia/Tashkent  18:05 local, first run after 2026-10-26: 2026-10-26T13:05Z
```

Berlindagi foydalanuvchi uchun UTC vaqt bir soatga siljidi, mahalliy 18:05 esa o'zgarmadi.

## Natija

Sinovda 100 ming dori uchun scheduler yaratdim. Keyin yana 10 ming dorini bitta daqiqaga to'g'riladim, ya'ni hamma bir vaqtda dori ichadigan eng og'ir holatni yaratdim. Oxirida 1000 ta dori vaqti kelgan paytda worker'ni 30 soniyaga o'chirib qo'ydim, xuddi deploy paytidagidek. Worker bitta process, `concurrency: 50`:

```text
100000 schedulers: 14.3 s to create, Redis +99.3 MB (1041 bytes each)
10000 due at 05:48 UTC: sent 10000, late p50 1984 ms, p95 3416 ms, last 3559 ms
worker stopped before 05:49:00 UTC
worker started 30 s after it
1000 due during the deploy: sent 1000, lost 0, late 32134 to 32496 ms; notifications 1000 for 1000 pills
```

Bir daqiqaga to'g'ri kelgan 10 ming eslatmaning hammasi 3.6 soniya ichida yuborildi. Deploy paytida vaqti kelgan eslatmalar esa yo'qolmadi: ular Redis'da kutib turdi va worker qaytgach yuborildi, takrorlar ham bo'lmadi. Sinovni ikki marta o'tkazdim va natijalar bir-biriga mos chiqdi.

| | Cron, har daqiqada | BullMQ job scheduler |
| --- | --- | --- |
| Postgres yuklamasi | Har daqiqada butun jadval: 100 ming dorida 26 ms, 1 mln dorida 131 ms dan 141 ms gacha | Faqat vaqti kelgan eslatma uchun bitta `INSERT` |
| Redis xotirasi | Kerak emas | Har bir dori uchun taxminan 1 KB: 100 ming dorida 99 MB |
| Deploy paytida | Eslatma yo'qoladi | Eslatma kechikadi, yo'qolmaydi |

Bu yechimning ham narxi bor. Jadval endi Redis'da yashaydi, shuning uchun Redis AOF bilan ishlashi kerak (sinovdagi Redis `appendonly yes` bilan ishladi). Biroq haqiqat manbai baribir Postgres bo'lib qoladi: Redis ma'lumotlari yo'qolsa, barcha scheduler'larni `pills` jadvalidan qayta yaratish mumkin. `upsertJobScheduler` idempotent, 100 ming dori uchun bu 14 soniya oldi.

```ts
const { rows } = await pool.query(
  `SELECT p.id, to_char(p.take_at, 'HH24:MI') AS take_at, u.timezone
     FROM pills p JOIN users u ON u.id = p.user_id`,
);
for (let i = 0; i < rows.length; i += 500) {
  await Promise.all(
    rows.slice(i, i + 500).map((p) => schedulePill({ id: p.id, takeAt: p.take_at }, p.timezone)),
  );
}
```

## Xulosa

- "Hozir kimga kerak?" deb har daqiqada so'raydigan cron ma'lumot bilan birga sekinlashadi va o'tkazib yuborilgan daqiqani qaytarib bermaydi.
- Delayed job vaqtni Redis'da saqlaydi: worker faqat vaqti kelgan eslatma uchun uyg'onadi, o'chiq bo'lsa esa eslatma uni kutib turadi.
- Timezone va yozgi vaqtni `tz` opsiyasi hisoblaydi, dori vaqti esa bazada foydalanuvchining mahalliy vaqtida qoladi.
- Haqiqat manbai Postgres: Redis AOF bilan ishlaydi, `UNIQUE (pill_id, due_at)` takrorni to'xtatadi, scheduler'lar esa istalgan payt jadvaldan qayta tiklanadi.
