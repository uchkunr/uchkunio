---
title: "Transactional outbox: microservice'lar o'rtasida real-time chat"
date: "2026-10-14"
excerpt: "Ikki servis o'rtasidagi chat xabarlari BullMQ orqali o'tganda Redis uzilishi va deploy bir vaqtga to'g'ri kelsa, 10 tadan 2 tasi yo'qolardi. Transactional outbox bilan xuddi shu sinovda 10 tadan 10 tasi yetib bordi, kechikish esa 10 ms atrofida qoldi."
tags:
  - architecture
  - postgresql
  - redis
  - bullmq
  - nodejs
---

Bizda ikki microservice bor: Consumers va Workers. Ular o'rtasida chat ishlaydi: bir tomonda yozilgan xabar ikkinchi tomonga real vaqtda va yo'qolmasdan yetib borishi kerak. Ikkala servis bitta Postgres bazasiga ulangan, lekin har biri faqat o'z jadvallari bilan ishlaydi:

```text
consumers.messages   Consumers tomonidan yuborilgan xabarlar
workers.messages     Workers tomonidan yuborilgan xabarlar
```

Baza bitta bo'lsa ham, Workers `consumers.messages` jadvalini to'g'ridan-to'g'ri o'qimaydi. Aks holda bir servis jadvalidagi har bir o'zgarish ikkinchisini buzadi, yangi xabar haqida esa baribir kimdir xabar berishi kerak. Shuning uchun xabarlar servislar o'rtasida ikkalasi ulangan bitta Redis orqali, BullMQ navbatida o'tadi.

## Birinchi versiya: bazaga yozish va queue.add

Birinchi versiyada men xabarni bazaga yozdim va shu zahoti navbatga qo'shdim:

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

Workers tomonida BullMQ worker job'ni oladi va xabarni chat socket'iga uzatadi:

```ts
import { Worker } from "bullmq";

new Worker(
  "chat-messages",
  async (job) => io.to(`chat:${job.data.chat_id}`).emit("message", job.data),
  { connection: { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null } },
);
```

Oddiy kunlarda bu ishladi. Biroq deploy paytida va Redis bilan aloqa uzilganda xabarlar yo'qola boshladi. Buni qayta ko'rsatish uchun ikkala servisni alohida process sifatida ishga tushirdim va har 400 ms da bitta xabar yubordim. 4-6 xabarlar paytida Workers deploy bo'ladi, 7-8 xabarlar paytida esa Redis o'chiq va xuddi shu payt Consumers ham deploy bo'ladi. Log qisqartirilgan:

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

Workers deploy bo'lgan paytda hech narsa yo'qolmadi: BullMQ job'ni Redis'da saqlaydi va worker qaytgach uni oladi. 7 va 8 xabarlar esa yo'qoldi. `INSERT` commit bo'ldi, lekin `queue.add` Redis'ga yetib bormadi: ioredis buyruqni offline queue'da, ya'ni process xotirasida ushlab turdi. Deploy process'ni to'xtatdi va xabar xotira bilan birga ketdi. Natijada xabar bazada bor, Workers esa u haqida hech qachon bilmaydi.

Bu muammo dual write deb ataladi: ikki xil tizimga yozuv bor, ularni birlashtiruvchi tranzaksiya esa yo'q. Tartibni almashtirish ham yordam bermaydi: avval `queue.add`, keyin `INSERT` qilinsa va `INSERT` xato bersa, Workers bazada yo'q xabarni ko'rsatadi. Retry ham yechim emas, chunki process ikki yozuv orasida o'lsa, retry qiladigan hech kim qolmaydi.

## Ikkinchi versiya: transactional outbox

Keyingi versiyada men transactional outbox pattern'ini qo'lladim. Har bir servisga outbox jadvali qo'shdim, u yerga har bir event yoziladi:

```sql
CREATE TABLE consumers.outbox (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event      text        NOT NULL,
  payload    jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);
CREATE INDEX outbox_unsent ON consumers.outbox (id) WHERE sent_at IS NULL;
-- workers.outbox xuddi shunday
```

Endi xabar Redis'ga emas, o'sha bazadagi outbox'ga yoziladi va bu xabarning o'zi bilan bitta tranzaksiyada bajariladi:

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
    await client.query("NOTIFY consumers_outbox"); // COMMIT'da yetkaziladi, ROLLBACK'da tashlab yuboriladi
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

Shu bilan xabar va uning event'i yoki birga mavjud, yoki birga yo'q. Redis o'chiq bo'lsa ham `sendMessage` muvaffaqiyatli tugaydi, chunki u faqat Postgres'ga yozadi.

## Relay: outbox'dan BullMQ'ga

Event'larni navbatga alohida jarayon, relay olib o'tadi. U yuborilmagan qatorlarni oladi, BullMQ'ga qo'shadi va yuborilgan deb belgilaydi:

```ts
// Offline queue yo'q: Redis o'chiq bo'lsa, addBulk darhol xato beradi va batch rollback bo'ladi.
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

Bu yerda uchta qaror bor. Birinchisi, `enableOfflineQueue: false`. Birinchi versiyada xabarlarni aynan offline queue yo'qotgan edi, relay esa hech narsani xotirada ushlab turmasligi kerak: xato bo'lsa, qatorlar outbox'da qoladi va keyingi aylanishda qayta olinadi. Ikkinchisi, `jobId` sifatida xabar id'si. Relay `addBulk`dan keyin, lekin `COMMIT`dan oldin o'lsa, qatorlar qayta yuboriladi, BullMQ esa mavjud `jobId` bilan kelgan job'ni qayta qo'shmaydi. Uchinchisi, `SKIP LOCKED` emas, oddiy `FOR UPDATE`. Rolling deploy paytida eski va yangi relay bir vaqtda ishlaydi. `SKIP LOCKED` ularga turli batch'larni parallel yuborishga ruxsat berib, chatdagi tartibni buzgan bo'lardi. Oddiy `FOR UPDATE` bilan ikkinchi relay birinchisi tugashini kutadi.

Relay vaqti-vaqti bilan outbox'ni tekshirib turishi mumkin, lekin chat uchun bu sekin. Shuning uchun u `LISTEN` qiladi va commit bo'lgan zahoti uyg'onadi, timeout esa faqat zaxira:

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
      console.error("relay:", (error as Error).message); // qatorlar outbox'da qoldi, keyingi aylanishda qayta olinadi
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, 1000);
    });
  }
}
```

## Workers: inbox va takrorlar

Outbox xabar yo'qolmasligini kafolatlaydi, lekin bir martadan ko'p kelmasligini kafolatlamaydi. Masalan, worker xabarni ko'rsatib, job tugashidan oldin o'lsa, BullMQ uni stalled deb topadi va qayta beradi. Shuning uchun Workers har bir xabarni o'z jadvaliga xabar id'si bo'yicha bir marta yozadi:

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
    // rowCount 0: bu takror, xabar allaqachon ko'rsatilgan
  },
  { connection: { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null } },
);
```

Teskari yo'nalish ham xuddi shunday ishlaydi: `workers.outbox`, uning relay'i va `consumers.inbox`.

## Natija

Xuddi shu sinov: Workers deploy, Redis uzilishi va shu paytdagi Consumers deploy. Qo'shimcha ravishda Workers 2-xabarni inbox'ga yozgan zahoti crash bo'ladi. Log qisqartirilgan:

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

7 va 8 xabarlar Redis qaytguncha outbox'da kutdi va yangi relay ularni yubordi. Crash'dan keyin qayta kelgan 2-xabarni inbox ushlab qoldi. Sinovni ikki marta o'tkazdim, natija bir xil chiqdi. Takror 12 soniyadan keyin keldi, chunki sinovda `lockDuration`ni 5 soniya qilgan edim, standart qiymat esa 30 soniya.

Real-time uchun kechikish ham muhim, shuning uchun 100 ta xabarni har 100 ms da yubordim va yuborilgan paytdan ko'rsatilgangacha bo'lgan vaqtni o'lchadim:

| Variant | p50 | p95 | O'lchovlar soni |
| --- | --- | --- | --- |
| v1: to'g'ridan `queue.add` | 6 dan 37 ms gacha | 18 dan 99 ms gacha | 7 |
| v2: outbox va `NOTIFY` | 9 dan 10 ms gacha | 18 dan 112 ms gacha | 7 |
| v2: faqat polling, 1 s | 534 dan 541 ms gacha | 985 dan 1012 ms gacha | 2 |

O'lchovlar Windows'dagi Docker Desktop'da, bitta mashinada o'tkazildi, shu sababli natijalar tarqoq. Biroq xulosa aniq: outbox chatni foydalanuvchi sezadigan darajada sekinlashtirmadi. Uni real-time qilib turgan narsa esa `NOTIFY`: busiz relay kechikishining medianasi yarim soniyaga chiqadi.

## Xulosa

- Xabar va uning event'i bitta tranzaksiyada yoziladi. Brokerga faqat relay yozadi.
- Relay hech narsani xotirada ushlab turmaydi: `enableOfflineQueue: false`, xato bo'lsa rollback. Xotirada kutib turgan narsa birinchi deploy'da yo'qoladi.
- Xabar kamida bir marta yetkaziladi, shuning uchun qabul qiluvchi takrorni id bo'yicha o'zi tashlaydi.
- Outbox yuborilgan xabarni Redis'ga topshiradi, undan keyin xavfsizlik Redis'ning o'ziga bog'liq. Sinovdagi Redis `appendonly yes` bilan ishladi. AOF bo'lmasa, Redis restart bo'lganda navbatdagi job'lar yo'qoladi.
