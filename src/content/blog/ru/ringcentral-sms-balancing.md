---
title: "SMS через RingCentral: ноль 429 с BullMQ, прямое сообщение уходит за 0.5 с впереди 5000 bulk"
date: "2026-10-14"
excerpt: "Когда bulk-кампания шла с интервалом 1.6 с, а прямое сообщение отправлялось в обход очереди, 2 из 5 прямых получили 429 и встали позади 4963 bulk-строк. Одна очередь BullMQ на аккаунт, приоритет и лимитер «один запрос в 1.67 с» свели 429 к нулю: прямое сообщение ушло за 0.5 с, и ни один из 5005 job'ов не потерялся."
tags:
  - architecture
  - reliability
  - redis
  - nestjs
---

RingCentral разрешает каждому аккаунту 40 запросов в минуту (группа Medium), при превышении лимита возвращает 429, а при повторяющихся 429 может временно заблокировать аккаунт. В Carlink (CRM для перевозки автомобилей) каждый диспетчер отправляет SMS через свой аккаунт, и есть три вида отправки: bulk (тысячи лидов одним нажатием), direct (одному номеру из чата) и автоматическое первое сообщение при назначении лида. Три требования: 429 не должно быть вовсе, ни одно сообщение не должно потеряться, bulk не должен блокировать direct.

## Почему первой версии недостаточно

В первой версии bulk-сообщения лежали в таблице `messages` в Postgres в статусе `Queued`, Hangfire job каждого пользователя отправлял их с интервалом 1.6 с (37.5 в минуту), а direct и первое сообщение шли в RingCentral напрямую, минуя очередь, и при 429 опускались в `Queued`. Логика выглядит просто: срочное сообщение не ждёт в очереди. Проблема в том, что лимит считается не в одном месте. Bulk-воркер сам расходует 37.5 запросов, а direct уходит, ничего не зная об оставшемся запасе того же аккаунта.

Стенд: fake RingCentral считает 40 запросов в окне 60 с и с 41-го возвращает 429. Один аккаунт, 5000 bulk, на 58-й секунде 5 direct:

```text
 58.0 s  direct #1 sent
 58.0 s  direct #2 sent
 58.0 s  direct #3 sent
 58.0 s  direct #4 429 -> Queued, behind 4963 bulk rows
 58.0 s  direct #5 429 -> Queued, behind 4963 bulk rows
 59.3 s  bulk  429, Retry-After 1s -> back to Queued
first minute: bulk sent 37, 429 total 3 (direct, direct, bulk)
```

Два прямых сообщения получили 429, опустились в `Queued` и, поскольку очередь FIFO, оказались позади 4963 bulk-строк. «Срочное» сообщение стало самым медленным сообщением в системе, а RingCentral увидел три 429 за одну минуту.

## Решение: одни ворота, приоритет внутри очереди

Правило одно: каждый запрос к RingCentral проходит через единственную очередь аккаунта, и в этой же очереди решаются и лимит, и приоритет. Срочное сообщение не обходит очередь, оно встаёт в её начало.

![Каждое SMS сначала становится строкой в Postgres, outbox relay добавляет его как job в очередь BullMQ аккаунта, в очереди порядок задают приоритет и лимитер, вебхук RingCentral возвращает статус доставки в таблицу, а cron реконсилера заново добавляет строки, у которых job потерялся](/sketches/sms/architecture.svg)

Технологии: NestJS, `@nestjs/bullmq` и BullMQ 6 (поверх Redis 7), Postgres (таблица `messages`, outbox), `@nestjs/schedule` (реконсилер), вебхук RingCentral (доставка). Задача каждой части:

| Часть | Задача |
| --- | --- |
| `messages` (Postgres) | Источник истины. Строка записывается в одной транзакции с бизнес-записью, `idempotency_key` unique |
| Очередь BullMQ `sms-{accountId}` | По одной на каждый аккаунт RingCentral. `priority`: direct 1, первое сообщение 2, bulk 3. `limiter`: один job в 1.667 с (36 в минуту, на 10% ниже 40). `concurrency: 1` |
| Processor | Вызывает RingCentral. При 429 ставит очередь на паузу на срок `Retry-After`, job не тратит попытку |
| Cron реконсилера | Заново добавляет строки в статусе `queued`, у которых нет живого job'а. Даже если Redis упадёт, сообщение не потеряется |
| Вебхук | Записывает статусы `delivered` и `failed` в `messages`. «Sent» означает, что RingCentral принял, а не что доставлено |

## Код

Сообщение сначала попадает в таблицу, а не в очередь. Тогда у HTTP-запроса и события лида один путь, и дубликаты останавливаются в базе:

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

Ключ строится в зависимости от пути: `bulk:{campaignId}:{leadId}`, `direct:{accountId}:{clientRequestId}`, `first:{leadId}`. Это тот же паттерн, что в посте про [ключ идемпотентности](/ru/blog/idempotency-keys), только сохраняется не ответ API, а строка сообщения.

Очередь и воркер для каждого аккаунта создаются в одном процессе через registry. В BullMQ 6 имя очереди не может содержать `:`, поэтому `sms-{accountId}`:

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

Добавление в очередь бывает двух видов: одно сообщение и целая кампания. В обоих случаях `jobId` равен id сообщения, поэтому если одно сообщение добавить дважды, BullMQ отбросит второе:

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

![5000 bulk-job'ов стоят в очереди аккаунта, direct job с приоритетом 1 будет взят следующим, а лимитер пропускает один job каждые 1.67 с, поэтому RingCentral не видит 429](/sketches/sms/priority.svg)

Processor различает три вида ошибок. Самый важный случай 429: job не падает, попытка не тратится, вся очередь встаёт на паузу на срок `Retry-After`:

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

Реконсилер служит страховкой очереди. Redis упал, процесс умер до того, как добавил job, кто-то вручную почистил очередь при `removeOnFail`: во всех случаях строка в Postgres остаётся, и cron её увидит:

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

Последнее слово в `messages` за вебхуком. При создании subscription RingCentral требует вернуть заголовок `Validation-Token`, а затем присылает событие на каждое изменение статуса сообщения:

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

Тот же стенд, та же нагрузка: 5000 bulk, на 58-й секунде 5 direct. BullMQ `limiter: { max: 1, duration: 1667 }`, приоритет direct 1, bulk 3:

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

Ноль 429. Первое прямое сообщение ушло за 507 мс (следующий свободный слот), остальные по одному каждые 1.67 с: хотя в очереди стояло 4963 bulk, direct job'ы заняли пять слотов подряд. Счёт job'ов 42 + 4963 = 5005: 5000 bulk, 5 direct, а одно сообщение, намеренно добавленное на стенде дважды, лишнего job'а не создало.

![Первая минута: в старом подходе bulk уходит каждые 1.6 с, а 5 direct на 58-й секунде выводят за лимит 40, и два из них получают 429; в новом подходе все запросы идут в слотах по 1.67 с, direct занимает ближайшие слоты, и 429 нет](/sketches/sms/first-minute.svg)

Второй прогон: допустим, провайдер без предупреждения снизил лимит до 30, то есть с нашим лимитером на 36 429 всё равно придёт:

```text
 50.2 s  429 from RingCentral: queue paused for 10 s, job b30 kept
 58.0 s  5 direct jobs added
 60.2 s  direct d1 sent after 2164 ms in queue
 ...
 66.9 s  direct d5 sent after 8835 ms in queue
sent 36 (bulk 31, direct 5), 429 total 1, queue pauses 1
job counts: {"waiting":0,"prioritized":4969,"completed":36,"failed":0}
```

Один 429, очередь встала на паузу на 10 с согласно `Retry-After`, job не упал, а после паузы прямые сообщения ушли первыми. Здесь нужно быть честным: пауза останавливает весь аккаунт, и direct тоже ждал 2.2 с. Это правильное поведение, потому что каждый запрос, отправленный во время паузы, снова получил бы 429, и блокировка стала бы ближе.

## Тесты

Без сети проверяются две вещи: порядок приоритетов и то, что после 429 job не теряется. Redis настоящий (локальный или Testcontainers), RingCentral fake, лимитер в тесте уменьшен до 50 мс, так что тест проходит за миллисекунды, а не за секунды:

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

Третий тест для реконсилера: записывается строка `queued`, job намеренно не добавляется, cron вызывается один раз, и проверяется, что job появился. Четвёртый для вебхука: запрос с `Validation-Token` возвращает 200 с этим же заголовком, а событие `Delivered` переводит строку в `delivered`.

## Ограничения

Лимитер BullMQ управляет очередью аккаунта и ничем больше: любой другой вызов, расходующий группу Medium этого аккаунта (например, список номеров), тоже должен проходить через эту очередь, иначе лимит снова делится на два места. Один Worker на аккаунт означает одно блокирующее соединение с Redis: 100 аккаунтов, 100 соединений, это нормально, но помните о `maxclients` в Redis. Групповые очереди (одна queue, группа по аккаунту и лимит на группу) есть в BullMQ Pro, а он платный. Когда появится multi-tenancy, имя очереди станет `sms-{tenantId}-{accountId}`, но лимит всё равно останется на уровне аккаунта, потому что RingCentral считает именно так.

## Правила

1. Лимит провайдера считается в одних воротах, и все пути проходят через них. «Срочный» путь в обход очереди: источник 429.
2. Приоритет внутри очереди, вместе с лимитом. Срочное сообщение не убегает от очереди, оно встаёт в её начало.
3. Настраивайте лимитер как интервал, а не как окно: `1 / 1667 ms` не превысит 36 в любые 60 с, а `36 / 60 s` пропускает все 36 разом в начале окна и, если окно сдвинуто относительно окна провайдера, даёт 429.
4. Не повторяйте 429, ждите: ставьте очередь на паузу на срок `Retry-After` и возвращайте job без траты попытки.
5. Источник истины Postgres, а очередь: планировщик. Без реконсилера, который возвращает строки без живого job'а, в день падения Redis сообщения потеряются.
