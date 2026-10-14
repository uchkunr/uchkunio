---
title: "SMS через RingCentral: ноль 429 с BullMQ, прямое сообщение уходит за 0.5 с впереди 5000 bulk"
date: "2026-10-14"
excerpt: "Bulk с интервалом 1.6 с, direct без очереди: 2 из 5 direct получили 429 и встали позади 4963 bulk. Одна очередь BullMQ на аккаунт, приоритет и лимитер «один запрос в 1.67 с»: ноль 429, direct ушёл за 0.5 с, ни один из 5005 job'ов не потерялся."
tags:
  - architecture
  - reliability
  - redis
  - nestjs
---

Лимит RingCentral: 40 запросов в минуту на аккаунт. Сверх лимита 429, при повторных 429 аккаунт временно блокируется. У нас три вида SMS:

- **bulk**: тысячи лидов одним запросом, 5000 это обычный случай
- **direct**: оператор отправляет одному номеру из чата
- **first message**: уходит автоматически при назначении лида

Требования: никаких 429, ни одно сообщение не теряется, direct и first message не ждут позади bulk.

## Проблема

В первой версии bulk-сообщения лежали в таблице `messages` в статусе `queued`, воркер отправлял их с интервалом 1.6 с (37.5 в минуту). Direct и first message в очередь не попадали: уходили в RingCentral напрямую, при 429 опускались в `queued`.

Лимит расходуется в двух местах. Воркер берёт 37.5, direct остаток не считает. Стенд: fake RingCentral считает 40 запросов в окне 60 с, с 41-го возвращает 429. Один аккаунт, 5000 bulk, на 58-й секунде 5 direct:

```text
 58.0 s  direct #1 sent
 58.0 s  direct #2 sent
 58.0 s  direct #3 sent
 58.0 s  direct #4 429 -> Queued, behind 4963 bulk rows
 58.0 s  direct #5 429 -> Queued, behind 4963 bulk rows
 59.3 s  bulk  429, Retry-After 1s -> back to Queued
first minute: bulk sent 37, 429 total 3 (direct, direct, bulk)
```

Два direct получили 429 и опустились в `queued`. Очередь FIFO, поэтому они встали позади 4963 bulk. RingCentral увидел три 429 за минуту.

## Решение

Все SMS одного аккаунта идут через одну очередь BullMQ: `sms-{accountId}`. Три настройки очереди:

- `priority`: direct 1, first message 2, bulk 3. Меньшее число берётся первым.
- `limiter: { max: 1, duration: 1667 }`: один job в 1.667 с, 36 в минуту. На 10% ниже 40.
- `concurrency: 1`.

Direct не обходит очередь, он встаёт в её начало. Лимит считается в одном месте.

![Каждое SMS сначала строка в Postgres, relay добавляет её как job в очередь BullMQ аккаунта, в очереди порядок задают приоритет и лимитер, вебхук RingCentral возвращает статус доставки в таблицу, а cron реконсилера заново добавляет строки, у которых job потерялся](/sketches/sms/architecture.svg)

Стек: NestJS, BullMQ 6 (Redis 7), Postgres (таблица `messages`), `@nestjs/schedule` (реконсилер), вебхук RingCentral.

| Часть | Задача |
| --- | --- |
| `messages` (Postgres) | Источник истины. Строка пишется в одной транзакции с бизнес-записью, `idempotency_key` unique |
| `sms-{accountId}` (BullMQ) | По одной на аккаунт. priority, limiter, concurrency 1 |
| Processor | Вызывает RingCentral. 429: очередь встаёт на паузу на срок `Retry-After`, job не тратит attempt |
| Cron реконсилера | Заново добавляет строки в статусе `queued`, у которых нет job'а |
| Вебхук | Пишет `delivered` и `failed` в `messages`. `sent` значит, что RingCentral принял, а не что доставлено |

## Код

Сообщение сначала пишется в таблицу. Дубликат останавливается на `idempotency_key`:

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

Ключи: `bulk:{campaignId}:{leadId}`, `direct:{accountId}:{clientRequestId}`, `first:{leadId}`. Паттерн тот же, что в посте про [ключ идемпотентности](/ru/blog/idempotency-keys).

Queue и Worker для каждого аккаунта создаются в registry. В BullMQ 6 имя очереди не может содержать `:`:

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

Добавление в очередь. `jobId` равен id сообщения: если одно сообщение добавить дважды, второе отбрасывается:

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

![5000 bulk-job'ов стоят в очереди аккаунта, direct job с приоритетом 1 берётся следующим, лимитер пропускает один job каждые 1.67 с, RingCentral не видит 429](/sketches/sms/priority.svg)

Processor. При 429 job не падает, attempt не тратится, очередь встаёт на паузу на срок `Retry-After`:

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

Реконсилер. Если Redis упал, процесс умер до добавления job'а или кто-то почистил failed set, строка остаётся в Postgres, и cron добавляет её заново:

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

Вебхук. При создании subscription RingCentral ждёт в ответ заголовок `Validation-Token`, затем присылает event на каждый статус сообщения:

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

## Измерение

Тот же стенд, та же нагрузка: 5000 bulk, на 58-й секунде 5 direct:

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

Ноль 429. Первый direct ушёл за 507 мс, остальные по одному каждые 1.67 с. 42 + 4963 = 5005: 5000 bulk, 5 direct. На стенде одно сообщение намеренно добавлено дважды, лишнего job'а оно не создало.

![Первая минута: в старой версии bulk уходит каждые 1.6 с, 5 direct на 58-й секунде выводят за лимит 40, два получают 429; в новой все запросы идут в слотах по 1.67 с, direct занимает ближайшие слоты, 429 нет](/sketches/sms/first-minute.svg)

Второй прогон: провайдер снизил лимит до 30, наш лимитер всё ещё 36:

```text
 50.2 s  429 from RingCentral: queue paused for 10 s, job b30 kept
 58.0 s  5 direct jobs added
 60.2 s  direct d1 sent after 2164 ms in queue
 ...
 66.9 s  direct d5 sent after 8835 ms in queue
sent 36 (bulk 31, direct 5), 429 total 1, queue pauses 1
job counts: {"waiting":0,"prioritized":4969,"completed":36,"failed":0}
```

Один 429, очередь встала на 10 с, `failed` ноль. Во время паузы direct тоже ждал (2.2 с). Это правильно: запрос, отправленный во время паузы, снова получит 429.

## Тесты

Redis настоящий, RingCentral fake, лимитер в тесте 50 мс. Проверяются две вещи: порядок приоритетов и то, что после 429 job не теряется:

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

Тест реконсилера: пишется строка `queued`, job не добавляется, вызывается cron, проверяется, что job появился. Тест вебхука: запрос с `Validation-Token` возвращает 200 с этим же заголовком, event `Delivered` переводит строку в `delivered`.

## Ограничения

- Другие вызовы, расходующие группу Medium этого аккаунта (например, список номеров), тоже должны идти через эту очередь. Иначе лимит снова расходуется в двух местах.
- Каждый Worker это одно блокирующее соединение с Redis: 100 аккаунтов, 100 соединений. Проверьте `maxclients`.
- В BullMQ Pro есть group'ы: одна очередь, group по аккаунту и лимит на group. Платно.
- Multi-tenancy: имя очереди `sms-{tenantId}-{accountId}`, лимит остаётся на уровне аккаунта.

## Правила

1. Один аккаунт, одна очередь. bulk, direct, first message, всё через неё.
2. Приоритет внутри очереди: direct 1, first message 2, bulk 3.
3. Лимитер `1 / 1667 ms`, а не `36 / 60 s`. Второй пропускает все 36 разом в начале окна и при сдвиге относительно окна провайдера даёт 429.
4. 429: `worker.rateLimit(retryAfter)`, `Worker.RateLimitError()`. Не retry, а пауза.
5. Postgres источник истины, BullMQ планировщик. Реконсилер заново добавляет строки без job'а.
