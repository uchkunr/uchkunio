---
title: "RingCentral orqali millionlab SMS'ni qanday balanslash mumkin: har akkauntga bitta BullMQ navbati, priority va 429 siz"
date: "2026-10-14"
excerpt: "Bulk 1.6 soniya oraliq bilan, direct esa navbatsiz yuborilganda 5 ta direct'dan 2 tasi 429 oldi va 4963 ta bulk orqasida qoldi. Har akkauntga bitta BullMQ navbati, priority va 1.67 soniyada bitta so'rov limiter'i: 429 nol, direct 0.5 soniyada ketdi, 5005 job'dan birortasi yo'qolmadi."
tags:
  - architecture
  - reliability
  - redis
  - nestjs
---

RingCentral limiti: har akkauntga daqiqasiga 40 ta so'rov. Oshsa 429, 429 takrorlansa akkaunt vaqtincha bloklanadi. Bizda uch xil SMS bor:

- **bulk**: bitta so'rovda minglab lead'ga, 5000 ta oddiy holat
- **direct**: operator chatdan bitta raqamga yuboradi
- **first message**: lead biriktirilganda avtomatik ketadi

Talab: 429 bo'lmasin, xabar yo'qolmasin, direct va first message bulk orqasida kutmasin.

## Muammo

Birinchi versiyada bulk xabarlar `messages` jadvalida `queued` holatida turardi, worker ularni 1.6 soniya oraliq bilan yuborardi (daqiqasiga 37.5 ta). Direct va first message navbatga kirmasdi: to'g'ridan-to'g'ri RingCentral'ga ketardi, 429 bo'lsa `queued` ga tushardi.

Limit ikki joyda sarflanadi. Worker 37.5 tasini oladi, direct esa qolganini hisoblamaydi. Stend: fake RingCentral 60 soniyalik oynada 40 ta so'rovni sanaydi, 41-chisidan 429. Bitta akkaunt, 5000 ta bulk, 58-soniyada 5 ta direct:

```text
 58.0 s  direct #1 sent
 58.0 s  direct #2 sent
 58.0 s  direct #3 sent
 58.0 s  direct #4 429 -> Queued, behind 4963 bulk rows
 58.0 s  direct #5 429 -> Queued, behind 4963 bulk rows
 59.3 s  bulk  429, Retry-After 1s -> back to Queued
first minute: bulk sent 37, 429 total 3 (direct, direct, bulk)
```

Ikkita direct 429 oldi va `queued` ga tushdi. Navbat FIFO, shuning uchun ular 4963 ta bulk orqasida qoldi. RingCentral bir daqiqada uchta 429 ko'rdi.

## Yechim

Bitta akkauntning hamma SMS'i bitta BullMQ navbatidan o'tadi: `sms-{accountId}`. Navbatda uchta sozlama:

- `priority`: direct 1, first message 2, bulk 3. Kichik raqam oldin olinadi.
- `limiter: { max: 1, duration: 1667 }`: 1.667 soniyada bitta job, daqiqasiga 36. 40 dan 10% past.
- `concurrency: 1`.

Direct navbatni chetlab o'tmaydi, navbatning boshiga qo'yiladi. Limit bitta joyda hisoblanadi.

![Har SMS avval Postgres'da qator, relay uni akkauntning BullMQ navbatiga job qilib qo'shadi, navbatda priority va limiter tartibni belgilaydi, RingCentral webhook'i yetkazilganlik holatini jadvalga qaytaradi, reconciler cron esa job'i yo'qolgan qatorlarni qayta qo'shadi](/sketches/sms/architecture.svg)

Stack: NestJS, BullMQ 6 (Redis 7), Postgres (`messages` jadvali), `@nestjs/schedule` (reconciler), RingCentral webhook.

| Qism | Vazifa |
| --- | --- |
| `messages` (Postgres) | Asosiy manba. Qator biznes yozuv bilan bitta transaction'da yoziladi, `idempotency_key` unique |
| `sms-{accountId}` (BullMQ) | Har akkauntga bittadan. priority, limiter, concurrency 1 |
| Processor | RingCentral'ni chaqiradi. 429: navbat `Retry-After` muddatiga to'xtaydi, job attempt sarflamaydi |
| Reconciler cron | `queued` holatida turgan, job'i yo'q qatorlarni qayta qo'shadi |
| Webhook | `delivered` va `failed` ni `messages` ga yozadi. `sent` RingCentral qabul qildi degani, yetkazildi emas |

## Kod

Xabar avval jadvalga yoziladi. Dublikat `idempotency_key` da to'xtaydi:

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

Kalitlar: `bulk:{campaignId}:{leadId}`, `direct:{accountId}:{clientRequestId}`, `first:{leadId}`. Naqsh [idempotency key](/blog/idempotency-keys) postidagi bilan bir xil.

Har akkaunt uchun Queue va Worker registry'da yaratiladi. BullMQ 6 da navbat nomida `:` bo'lmaydi:

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

Navbatga qo'shish. `jobId` xabar id'si, bir xabar ikki marta qo'shilsa ikkinchisi tashlab yuboriladi:

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

![5000 ta bulk job akkauntning navbatida turibdi, priority 1 bilan kelgan direct job keyingi bo'lib olinadi, limiter har 1.67 soniyada bitta job o'tkazadi, RingCentral 429 ko'rmaydi](/sketches/sms/priority.svg)

Processor. 429 da job yiqilmaydi, attempt sarflanmaydi, navbat `Retry-After` muddatiga to'xtaydi:

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

Reconciler. Redis o'chsa, job qo'shilguncha jarayon o'lsa yoki kimdir failed set'ni tozalasa, qator Postgres'da qoladi va cron uni qayta qo'shadi:

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

Webhook. Subscription yaratilganda RingCentral `Validation-Token` header'ini qaytarishni kutadi, keyin har xabar holati uchun event yuboradi:

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

Xuddi shu stend, xuddi shu yuk: 5000 ta bulk, 58-soniyada 5 ta direct:

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

429 nol. Birinchi direct 507 ms da ketdi, qolganlari har 1.67 soniyada bittadan. 42 + 4963 = 5005: 5000 bulk, 5 direct. Stendda bitta xabar ataylab ikki marta qo'shilgan, qo'shimcha job yaratmagan.

![Birinchi daqiqa: eski versiyada bulk har 1.6 soniyada ketadi, 58-soniyadagi 5 ta direct 40 limitdan oshiradi, ikkitasi 429 oladi; yangisida hamma so'rov 1.67 soniyalik slotlarda ketadi, direct keyingi slotlarni oladi, 429 yo'q](/sketches/sms/first-minute.svg)

Ikkinchi sinov: provayder limitni 30 ga tushirgan, limiter'imiz hali 36:

```text
 50.2 s  429 from RingCentral: queue paused for 10 s, job b30 kept
 58.0 s  5 direct jobs added
 60.2 s  direct d1 sent after 2164 ms in queue
 ...
 66.9 s  direct d5 sent after 8835 ms in queue
sent 36 (bulk 31, direct 5), 429 total 1, queue pauses 1
job counts: {"waiting":0,"prioritized":4969,"completed":36,"failed":0}
```

Bitta 429, navbat 10 soniya to'xtadi, `failed` nol. Pauza paytida direct ham kutdi (2.2 soniya). Bu to'g'ri: pauza paytida yuborilgan so'rov yana 429 bo'ladi.

## Testlar

Redis haqiqiy, RingCentral fake, limiter testda 50 ms. Ikki narsa tekshiriladi: priority tartibi va 429 dan keyin job yo'qolmasligi:

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

Reconciler testi: `queued` qator yoziladi, job qo'shilmaydi, cron chaqiriladi, job paydo bo'lishi tekshiriladi. Webhook testi: `Validation-Token` bilan kelgan so'rov shu header bilan 200 qaytaradi, `Delivered` event qatorni `delivered` qiladi.

## Chegaralar

- Shu akkauntning Medium guruhidan foydalanadigan boshqa chaqiruvlar (masalan, raqamlar ro'yxati) ham shu navbat orqali o'tishi kerak. Aks holda limit yana ikki joyda sarflanadi.
- Har Worker bitta bloklovchi Redis ulanish: 100 akkaunt, 100 ulanish. `maxclients` ni tekshiring.
- BullMQ Pro'da group'lar bor: bitta navbat, akkaunt bo'yicha group va group limit. Pullik.
- Multi-tenancy: navbat nomi `sms-{tenantId}-{accountId}`, limit akkaunt darajasida qoladi.

## Qoidalar

1. Bitta akkaunt, bitta navbat. bulk, direct, first message, hammasi shu navbatdan.
2. Priority navbat ichida: direct 1, first message 2, bulk 3.
3. Limiter `1 / 1667 ms`, `36 / 60 s` emas. Ikkinchisi oynaning boshida 36 tasini yoppasiga o'tkazadi, provayder oynasi bilan siljisa 429 beradi.
4. 429: `worker.rateLimit(retryAfter)`, `Worker.RateLimitError()`. Retry emas, pauza.
5. Postgres asosiy manba, BullMQ rejalashtiruvchi. Reconciler job'i yo'q qatorlarni qayta qo'shadi.
