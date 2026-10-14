---
title: "RingCentral orqali SMS: BullMQ bilan 429 yo'q, direct xabar 5000 ta bulk oldidan 0.5 soniyada ketadi"
date: "2026-10-14"
excerpt: "Bulk kampaniya 1.6 soniya oraliq bilan, direct xabar esa navbatni chetlab yuborilganda 5 ta direct'dan 2 tasi 429 olib, 4963 ta bulk qatori orqasiga tushdi. Har akkauntga bitta BullMQ navbati, priority va 1.67 soniyada bitta so'rov limiter'i bilan 429 nolga tushdi, direct xabar 0.5 soniyada ketdi va 5005 job'dan birortasi yo'qolmadi."
tags:
  - architecture
  - reliability
  - redis
  - nestjs
---

RingCentral har bir akkaunt uchun daqiqasiga 40 ta so'rovga ruxsat beradi (Medium guruh), limitdan oshsa 429 qaytaradi, 429 takrorlansa akkauntni vaqtincha bloklashi mumkin. Carlink (avtomobil tashish CRM'i) da har dispatcher o'z akkaunti orqali SMS yuboradi va uch xil yuborish bor: bulk (bir bosishda minglab lead'ga), direct (chatdan bitta raqamga) va lead biriktirilganda avtomatik birinchi xabar. Uchta talab: 429 umuman bo'lmasin, birorta xabar yo'qolmasin, bulk direct'ni to'sib qo'ymasin.

## Birinchi versiya nega yetarli emas

Birinchi versiyada bulk xabarlar Postgres'dagi `messages` jadvalida `Queued` holatida turardi, har foydalanuvchining Hangfire job'i ularni 1.6 soniya oraliq bilan yuborardi (daqiqasiga 37.5 ta), direct va birinchi xabar esa navbatni chetlab RingCentral'ga to'g'ri ketardi, 429 bo'lsa `Queued` ga tushardi. Mantiq oddiy ko'rinadi: shoshilinch xabar navbatda kutmaydi. Muammo shundaki, limit bitta joyda emas. Bulk worker 37.5 ta so'rovni o'zi sarflaydi, direct esa shu akkauntning qolgan zaxirasidan bexabar yuboriladi.

Stend: fake RingCentral 60 soniyalik oynada 40 ta so'rovni sanaydi va 41-chisidan 429 qaytaradi. Bitta akkaunt, 5000 ta bulk, 58-soniyada 5 ta direct:

```text
 58.0 s  direct #1 sent
 58.0 s  direct #2 sent
 58.0 s  direct #3 sent
 58.0 s  direct #4 429 -> Queued, behind 4963 bulk rows
 58.0 s  direct #5 429 -> Queued, behind 4963 bulk rows
 59.3 s  bulk  429, Retry-After 1s -> back to Queued
first minute: bulk sent 37, 429 total 3 (direct, direct, bulk)
```

Ikki direct xabar 429 oldi, `Queued` ga tushdi va navbat FIFO bo'lgani uchun 4963 ta bulk qatorining orqasida qoldi. "Shoshilinch" xabar tizimdagi eng sekin xabarga aylandi, RingCentral esa bir daqiqada uchta 429 ko'rdi.

## Yechim: bitta darvoza, navbat ichida priority

Qoida bitta: RingCentral'ga ketadigan har bir so'rov akkauntning bitta navbatidan o'tadi va shu navbatda limit ham, priority ham hal qilinadi. Shoshilinch xabar navbatni chetlab o'tmaydi, u navbatning boshiga turadi.

![Har SMS avval Postgres'da qator, outbox relay uni akkauntning BullMQ navbatiga job qilib qo'shadi, navbatda priority va limiter tartibni belgilaydi, RingCentral webhook'i yetkazilganlik holatini jadvalga qaytaradi, reconciler cron esa job'i yo'qolgan qatorlarni qayta qo'shadi](/sketches/sms/architecture.svg)

Texnologiyalar: NestJS, `@nestjs/bullmq` va BullMQ 6 (Redis 7 ustida), Postgres (`messages` jadvali, outbox), `@nestjs/schedule` (reconciler), RingCentral webhook (yetkazilganlik). Har qismning vazifasi:

| Qism | Vazifa |
| --- | --- |
| `messages` (Postgres) | Haqiqat manbai. Qator biznes yozuv bilan bitta transaction'da yoziladi, `idempotency_key` unique |
| BullMQ navbati `sms-{accountId}` | Har RingCentral akkauntiga bittadan. `priority`: direct 1, birinchi xabar 2, bulk 3. `limiter`: 1.667 s da bitta job (daqiqasiga 36, 40 dan 10% past). `concurrency: 1` |
| Processor | RingCentral'ni chaqiradi. 429 bo'lsa `Retry-After` muddatiga navbatni to'xtatadi, job urinish sarflamaydi |
| Reconciler cron | `queued` holatida turgan, jonli job'i yo'q qatorlarni qayta qo'shadi. Redis o'chsa ham xabar yo'qolmaydi |
| Webhook | `delivered` va `failed` holatlarini `messages` ga yozadi. "Sent" RingCentral qabul qildi degani, yetkazildi degani emas |

## Kod

Xabar avval jadvalga tushadi, navbatga emas. Shunda HTTP so'rov va lead event uchun bitta yo'l bor va dublikatlar bazada to'xtaydi:

```ts
// messages.repository.ts
// One row per message. The idempotency key stops the same message from being
// created twice: a retried HTTP request, a re-delivered lead event, a double click.
export type Kind = "direct" | "first_message" | "bulk";

export class MessagesRepository {
  constructor(private readonly db: Pool) {}

  async create(tx: PoolClient, m: { accountId: string; kind: Kind; to: string; body: string; key: string }) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO messages (account_id, kind, "to", body, idempotency_key, status)
       VALUES ($1, $2, $3, $4, $5, 'queued')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [m.accountId, m.kind, m.to, m.body, m.key],
    );
    return rows[0]?.id ?? null; // null: already exists, nothing to enqueue
  }
}
```

Kalit yo'lga qarab tuziladi: `bulk:{campaignId}:{leadId}`, `direct:{accountId}:{clientRequestId}`, `first:{leadId}`. Bu [idempotency key](/blog/idempotency-keys) postidagi naqsh, faqat API javobi emas, xabar qatori saqlanadi.

Har akkaunt uchun navbat va worker bitta jarayonda, registry orqali yaratiladi. BullMQ 6 da navbat nomida `:` bo'lmaydi, shuning uchun `sms-{accountId}`:

```ts
// sms-queues.ts
// One Queue and one Worker per RingCentral account. The limiter is the single gate:
// at most one job every 1667 ms, so no 60-second window ever holds more than 36 calls.
import { Queue, Worker, Job } from "bullmq";

export const PRIORITY: Record<Kind, number> = { direct: 1, first_message: 2, bulk: 3 };

@Injectable()
export class SmsQueues implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();

  constructor(private readonly connection: IORedis, private readonly processor: SmsProcessor) {}

  for(accountId: string): Queue {
    let queue = this.queues.get(accountId);
    if (queue) return queue;
    const name = `sms-${accountId}`;
    queue = new Queue(name, { connection: this.connection });
    const worker = new Worker(name, (job) => this.processor.handle(job, worker), {
      connection: this.connection,
      concurrency: 1,
      limiter: { max: 1, duration: 1_667 }, // 36 per minute, under RingCentral's 40
    });
    this.queues.set(accountId, queue);
    this.workers.set(accountId, worker);
    return queue;
  }

  async onModuleDestroy() {
    // Finish the job in flight, then stop; the limiter state stays in Redis.
    await Promise.all([...this.workers.values()].map((w) => w.close()));
  }
}
```

Navbatga qo'shish ikki xil: bitta xabar va butun kampaniya. Ikkalasida ham `jobId` xabarning id'si, shuning uchun bir xabar ikki marta qo'shilsa BullMQ ikkinchisini tashlab yuboradi:

```ts
// sms-enqueue.service.ts
@Injectable()
export class SmsEnqueueService {
  constructor(private readonly queues: SmsQueues) {}

  async one(accountId: string, messageId: string, kind: Kind) {
    await this.queues.for(accountId).add(kind, { messageId }, this.opts(messageId, kind));
  }

  // A 5000-lead campaign is one round trip to Redis, not 5000.
  async campaign(accountId: string, messageIds: string[]) {
    await this.queues.for(accountId).addBulk(
      messageIds.map((messageId) => ({ name: "bulk", data: { messageId }, opts: this.opts(messageId, "bulk") })),
    );
  }

  private opts(messageId: string, kind: Kind): JobsOptions {
    return {
      jobId: messageId,            // idempotent: the same message is one job
      priority: PRIORITY[kind],    // lower number runs first
      attempts: 5,                 // transient errors only, see the processor
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 10_000,    // keep a window of history for the dashboard
      removeOnFail: false,         // failed jobs stay visible until someone looks
    };
  }
}
```

![5000 ta bulk job akkauntning navbatida turibdi, priority 1 bilan kelgan direct job keyingi bo'lib olinadi, limiter esa har 1.67 soniyada bitta job o'tkazadi, shuning uchun RingCentral 429 ko'rmaydi](/sketches/sms/priority.svg)

Processor uch xil xatoni uch xil ko'radi. 429 eng muhimi: job yiqilmaydi, urinish sarflanmaydi, butun navbat `Retry-After` muddatiga to'xtaydi:

```ts
// sms.processor.ts
@Injectable()
export class SmsProcessor {
  constructor(private readonly messages: MessagesRepository, private readonly rc: RingCentralClient) {}

  async handle(job: Job<{ messageId: string }>, worker: Worker) {
    const message = await this.messages.get(job.data.messageId);
    if (!message || message.status !== "queued") return; // already sent or cancelled

    // Written before the call: if the process dies here, the row is "maybe sent"
    // and the reconciler will not blindly re-add it.
    await this.messages.setStatus(message.id, "sending");
    try {
      const sent = await this.rc.sendSms(message.accountId, message.to, message.body);
      await this.messages.markSent(message.id, sent.id); // the webhook will upgrade it to delivered
    } catch (e) {
      if (e instanceof RingCentralError && e.status === 429) {
        // Pause this account's queue for the provider's window; the job stays queued.
        await worker.rateLimit((e.retryAfter ?? 60) * 1000);
        await this.messages.setStatus(message.id, "queued");
        throw Worker.RateLimitError();
      }
      if (isNonRetryable(e)) {
        // Invalid number, opted out, blocked content: retrying cannot help.
        await this.messages.markFailed(message.id, e.code);
        return;
      }
      await this.messages.setStatus(message.id, "queued");
      throw e; // transient: attempts and backoff take over
    }
  }
}
```

Reconciler navbatning sug'urtasi. Redis o'chib ketgan, job qo'shishdan oldin jarayon o'lgan, `removeOnFail` bilan kimdir qo'lda tozalagan: hammasida Postgres'dagi qator qoladi va cron uni ko'radi:

```ts
// sms-reconciler.ts
@Injectable()
export class SmsReconciler {
  constructor(private readonly messages: MessagesRepository, private readonly queues: SmsQueues, private readonly enqueue: SmsEnqueueService) {}

  @Cron("*/2 * * * *")
  async run() {
    // "sending" older than 5 minutes: the worker died mid-call. Back to queued.
    await this.messages.requeueStale("sending", "5 minutes");

    // queued rows whose job is gone: re-add them under the same jobId.
    for (const row of await this.messages.queuedOlderThan("1 minute")) {
      const job = await this.queues.for(row.accountId).getJob(row.id);
      if (!job) await this.enqueue.one(row.accountId, row.id, row.kind);
    }
  }
}
```

Webhook `messages` ga oxirgi so'zni aytadi. RingCentral subscription yaratilganda `Validation-Token` header'ini qaytarishni talab qiladi, keyin har xabar holati uchun event yuboradi:

```ts
// ringcentral-webhook.controller.ts
@Controller("webhooks/ringcentral")
export class RingCentralWebhookController {
  constructor(private readonly messages: MessagesRepository) {}

  @Post()
  @HttpCode(200)
  async receive(@Headers("validation-token") token: string | undefined, @Res({ passthrough: true }) res: Response, @Body() event: RcEvent) {
    if (token) {
      res.setHeader("Validation-Token", token); // subscription handshake
      return;
    }
    const { id, messageStatus } = event.body;
    if (messageStatus === "Delivered") await this.messages.markDelivered(id);
    if (messageStatus === "DeliveryFailed" || messageStatus === "SendingFailed") await this.messages.markFailed(id, messageStatus);
  }
}
```

## O'lchov

Xuddi shu stend, xuddi shu yuk: 5000 ta bulk, 58-soniyada 5 ta direct. BullMQ `limiter: { max: 1, duration: 1667 }`, priority direct 1, bulk 3:

```text
  0.4 s  5000 bulk jobs added
 58.4 s  5 direct jobs added
 58.9 s  direct d1 sent after 507 ms in queue
 60.5 s  direct d2 sent after 2174 ms in queue
 62.2 s  direct d3 sent after 3842 ms in queue
 63.9 s  direct d4 sent after 5511 ms in queue
 65.6 s  direct d5 sent after 7179 ms in queue
sent 42 (bulk 37, direct 5), 429 total 0, queue pauses 0
job counts: {"waiting":0,"prioritized":4963,"completed":42,"failed":0}
```

429 nol. Birinchi direct 507 ms da ketdi (keyingi bo'sh slot), qolganlari har 1.67 soniyada bittadan: navbatda 4963 ta bulk turgan bo'lsa ham direct job'lar ketma-ket beshta slotni oldi. Job'lar hisobi 42 + 4963 = 5005: 5000 bulk, 5 direct, va stendda ataylab ikki marta qo'shilgan bitta xabar qo'shimcha job yaratmadi.

![Birinchi daqiqa: eski yondashuvda bulk har 1.6 soniyada ketadi va 58-soniyadagi 5 ta direct 40 limitdan oshirib yuboradi, ikkitasi 429 oladi; yangi yondashuvda hamma so'rov 1.67 soniyalik slotlarda ketadi, direct keyingi slotlarni oladi va 429 bo'lmaydi](/sketches/sms/first-minute.svg)

Ikkinchi sinov: provayder limitni ogohlantirmasdan 30 ga tushirgan deylik, ya'ni limiter'imiz 36 bilan baribir 429 keladi:

```text
 50.2 s  429 from RingCentral: queue paused for 10 s, job b30 kept
 58.0 s  5 direct jobs added
 60.2 s  direct d1 sent after 2164 ms in queue
 ...
 66.9 s  direct d5 sent after 8835 ms in queue
sent 36 (bulk 31, direct 5), 429 total 1, queue pauses 1
job counts: {"waiting":0,"prioritized":4969,"completed":36,"failed":0}
```

Bitta 429, navbat `Retry-After` ga ko'ra 10 soniya to'xtadi, job yiqilmadi, pauza tugagach direct'lar birinchi bo'lib ketdi. Bu yerda halol bo'lish kerak: pauza butun akkauntni to'xtatadi, direct ham 2.2 soniya kutdi. Bu to'g'ri xulq, chunki pauza paytida yuborilgan har so'rov yana 429 bo'lardi va blok yaqinlashardi.

## Testlar

Ikki narsa tarmoqsiz tekshiriladi: priority tartibi va 429 dan keyin job yo'qolmasligi. Redis haqiqiy (lokal yoki Testcontainers), RingCentral fake, limiter testda 50 ms ga tushiriladi, shunda test soniyalarda emas, millisoniyalarda o'tadi:

```ts
// sms.e2e.spec.ts
class FakeRingCentral implements RingCentralClient {
  sent: string[] = [];
  failWith429 = 0; // how many calls to reject before behaving

  async sendSms(_account: string, to: string) {
    if (this.failWith429-- > 0) throw new RingCentralError(429, "Too Many Requests", { retryAfter: 1 });
    this.sent.push(to);
    return { id: `rc-${this.sent.length}` };
  }
}

it("a direct message overtakes a 1000-job bulk campaign", async () => {
  await enqueue.campaign("acc-1", bulkIds); // 1000 queued rows
  await enqueue.one("acc-1", directId, "direct");
  await waitFor(() => rc.sent.length >= 2);
  expect(rc.sent[0]).toBe(directTo);       // first slot after the one already running
  expect(rc.sent.slice(1).every((to) => to.startsWith("+1555"))).toBe(true);
});

it("a 429 pauses the queue and loses nothing", async () => {
  rc.failWith429 = 1;
  await enqueue.campaign("acc-1", bulkIds.slice(0, 20));
  await waitFor(() => rc.sent.length === 20, { timeout: 5_000 }); // resumes after retryAfter
  const counts = await queues.for("acc-1").getJobCounts("failed", "completed");
  expect(counts).toEqual({ failed: 0, completed: 20 });
  expect(await messages.countByStatus("acc-1", "failed")).toBe(0);
});
```

Uchinchi test reconciler uchun: `queued` qator yoziladi, job ataylab qo'shilmaydi, cron bir marta chaqiriladi va job paydo bo'lishi tekshiriladi. To'rtinchisi webhook: `Validation-Token` bilan kelgan so'rov shu header bilan 200 qaytaradi, `Delivered` event esa qatorni `delivered` qiladi.

## Chegaralar

BullMQ limiter'i akkauntning navbatini boshqaradi, boshqa hech narsani: shu akkauntning Medium guruhidan foydalanadigan har qanday boshqa chaqiruv (masalan, raqamlar ro'yxati) ham shu navbat orqali o'tishi kerak, aks holda limit yana ikki joyga bo'linadi. Har akkauntga bitta Worker bitta bloklovchi Redis ulanish degani: 100 akkaunt, 100 ulanish, bu normal, lekin Redis `maxclients` ni bilib qo'ying. Guruhli navbat (bitta queue, akkaunt bo'yicha group va group limit) BullMQ Pro'da bor, u pullik. Multi-tenancy kelganda navbat nomi `sms-{tenantId}-{accountId}` bo'ladi, limit baribir akkaunt darajasida qoladi, chunki RingCentral shunday sanaydi.

## Qoidalar

1. Provayder limiti bitta darvozada hisoblansin va hamma yo'l shu darvozadan o'tsin. Navbatni chetlab o'tadigan "shoshilinch" yo'l 429 ning manbai.
2. Priority navbat ichida, limit bilan birga. Shoshilinch xabar navbatdan qochmaydi, navbatning boshiga turadi.
3. Limiter'ni oyna emas, oraliq sifatida sozlang: `1 / 1667 ms` istalgan 60 soniyada 36 dan oshmaydi, `36 / 60 s` esa oynaning boshida 36 tasini yoppasiga o'tkazadi va provayder oynasi bilan siljisa 429 beradi.
4. 429 ni retry qilmang, kuting: `Retry-After` muddatiga navbatni to'xtating va job'ni urinish sarflamasdan qaytaring.
5. Haqiqat manbai Postgres, navbat esa rejalashtiruvchi. Jonli job'i yo'q qatorlarni qaytaradigan reconciler bo'lmasa, Redis o'chgan kuni xabarlar yo'qoladi.
