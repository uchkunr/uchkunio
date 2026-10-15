---
title: "Отправка уведомлений в назначенное время"
date: "2026-10-14"
excerpt: "Cron, запускавшийся каждую минуту, тратил больше 130 мс на каждый запуск, чтобы найти напоминания одной минуты среди 1 млн лекарств, а минута, пропущенная во время деплоя, теряла эти напоминания навсегда. С job scheduler в BullMQ повторяющийся запрос к базе исчез, а пока воркер 30 секунд был выключен, не потерялось ни одно из 1000 наступивших напоминаний."
tags:
  - bullmq
  - redis
  - postgresql
  - nodejs
  - scheduling
---

Пользователи каждый день принимают лекарства в определённое время: Ситрамон в 18:00, Амоксициллин утром в 09:00 и так далее. Каждый пользователь делает это в своём часовом поясе: 18:00 в Ташкенте и 18:00 в Берлине это два разных момента. Система же должна отправить уведомление через 5 минут после времени приёма, то есть в 18:05.

Лекарства хранятся в таблице `pills` вместе с id пользователя, а время записывается в местном времени пользователя:

```sql
CREATE TABLE users (
  id       bigint PRIMARY KEY,
  timezone text   NOT NULL            -- IANA: Asia/Tashkent, Europe/Berlin, ...
);

CREATE TABLE pills (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users,
  name    text   NOT NULL,
  take_at time   NOT NULL             -- местное время пользователя
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

## Первая версия: cron каждую минуту

В первой версии cron каждую минуту вызывал один route. Route находит в `pills` лекарства, о которых нужно напомнить именно в эту минуту, записывает их в `notifications` и отправляет:

```sql
INSERT INTO notifications (pill_id, user_id, due_at)
SELECT p.id, p.user_id, date_trunc('minute', now())
FROM pills p JOIN users u ON u.id = p.user_id
WHERE p.take_at + interval '5 minutes' = date_trunc('minute', now() AT TIME ZONE u.timezone)::time
ON CONFLICT DO NOTHING
RETURNING pill_id, user_id;
```

Первая проблема этого решения в ресурсах. Условие зависит от часового пояса пользователя в каждой строке, поэтому индекс по `take_at` не используется, и Postgres каждый раз читает обе таблицы целиком. На 50 тысячах пользователей и 100 тысячах лекарств (сокращено):

```text
Hash Join (actual time=15.278..26.014 rows=81.00 loops=1)
  ->  Seq Scan on pills p (actual time=0.006..3.522 rows=100000.00 loops=1)
  ->  Hash (actual time=14.889..14.890 rows=50000.00 loops=1)
        ->  Seq Scan on users u (actual time=0.004..1.872 rows=50000.00 loops=1)
Execution Time: 26.073 ms
```

Чтобы найти 81 напоминание, прочитано 150 тысяч строк. Это повторяется 1440 раз в сутки. Когда данных стало в 10 раз больше, то есть 1 млн лекарств, один запуск занял от 131 до 141 мс, и Postgres подключил к нему два параллельных воркера. В итоге база читает всю таблицу даже в минуту, когда напоминаний нет совсем.

Вторая проблема серьёзнее. Запрос проверяет только текущую минуту. Если во время деплоя route не ответит в 18:05, напоминания этой минуты не найдутся и при следующем запуске. Для пользователя из Ташкента и его Ситрамона в 18:00 я запустил route в 18:04, 18:06 и 18:07, а 18:05 пришлось на деплой:

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

Тот же запрос в 18:05 находит это лекарство:

```text
cron at 18:05: 1 notification(s) for user 8
```

Но этот запуск был пропущен, и пользователь так и не получил напоминание. Такую ошибку никто не замечает: в логе ошибок нет, уведомление просто не приходит.

## Вторая версия: delayed job в BullMQ

Во второй версии я убрал cron, который проверял каждую минуту. Теперь никто не спрашивает каждую минуту «кому сейчас напомнить?». Вместо этого каждое лекарство само сообщает Redis, когда о нём нужно напомнить, а воркер просыпается ровно в этот момент. Для этого в BullMQ есть job scheduler: по одному scheduler на лекарство, с cron-паттерном и часовым поясом пользователя.

```ts
import { Queue } from "bullmq";

const reminders = new Queue("pill-reminders", { connection });

/** О лекарстве на 18:00 напоминаем в 18:05, по времени самого пользователя. */
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

`schedulePill` вызывается, когда лекарство добавлено или его время изменилось, а также когда пользователь меняет часовой пояс. `upsertJobScheduler` заменяет старое расписание с тем же id, поэтому вызывать его повторно безопасно. Когда лекарство удаляется, вызывается `unschedulePill`.

Сам scheduler никакой работы не делает. Он хранит в Redis один delayed job для следующего напоминания, то есть одну запись в множестве, отсортированном по времени. Когда время наступает, воркер забирает её, а BullMQ сразу же создаёт следующий job. Чтобы это увидеть, я создал scheduler, срабатывающий каждые 2 секунды, и вывел job'ы (сокращено):

```text
{"id":"repeat:pill-1:1792042950000", ..., "processedOn":1792042950089, ..., "opts":{..., "prevMillis":1792042950000, ...}}
{"id":"repeat:pill-1:1792042952000","timestamp":1792042950091, ...}
```

Второй job создан через 2 мс после старта первого, то есть у каждого лекарства в Redis в любой момент только один ожидающий job. А `prevMillis` хранит момент, на который job был запланирован. Воркер записывает этот `prevMillis` как `due_at`, а `UNIQUE (pill_id, due_at)` не даёт отправить одно напоминание дважды:

```ts
import { Worker } from "bullmq";

new Worker(
  "pill-reminders",
  async (job) => {
    const dueAt = job.opts.prevMillis!; // момент, на который запланирован этот job
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

Расчёт часовых поясов тоже берёт на себя BullMQ. 25 октября Берлин уходит с летнего времени, а в Ташкенте такого перехода нет:

```text
Europe/Berlin  18:05 local, first run after 2026-10-24: 2026-10-24T16:05Z
Asia/Tashkent  18:05 local, first run after 2026-10-24: 2026-10-24T13:05Z
Europe/Berlin  18:05 local, first run after 2026-10-26: 2026-10-26T17:05Z
Asia/Tashkent  18:05 local, first run after 2026-10-26: 2026-10-26T13:05Z
```

Для пользователя в Берлине время в UTC сдвинулось на час, а местные 18:05 остались прежними.

## Результат

В тесте я создал scheduler'ы для 100 тысяч лекарств. Затем ещё 10 тысяч лекарств назначил на одну и ту же минуту: худший случай, когда все принимают лекарство одновременно. В конце я выключил воркер на 30 секунд, пока наступало время 1000 лекарств, как во время деплоя. Воркер это один процесс с `concurrency: 50`:

```text
100000 schedulers: 14.3 s to create, Redis +99.3 MB (1041 bytes each)
10000 due at 05:48 UTC: sent 10000, late p50 1984 ms, p95 3416 ms, last 3559 ms
worker stopped before 05:49:00 UTC
worker started 30 s after it
1000 due during the deploy: sent 1000, lost 0, late 32134 to 32496 ms; notifications 1000 for 1000 pills
```

Все 10 тысяч напоминаний, пришедшихся на одну минуту, отправлены за 3,6 с. А напоминания, время которых наступило во время деплоя, не потерялись: они ждали в Redis и были отправлены, когда воркер вернулся, без дубликатов. Я провёл тест дважды, и результаты совпали.

| | Cron каждую минуту | Job scheduler в BullMQ |
| --- | --- | --- |
| Нагрузка на Postgres | Вся таблица каждую минуту: 26 мс на 100 тысяч лекарств, от 131 до 141 мс на 1 млн | Один `INSERT` на наступившее напоминание, и всё |
| Память Redis | Не нужна | Около 1 КБ на лекарство: 99 МБ на 100 тысяч |
| Во время деплоя | Напоминание теряется | Напоминание опаздывает, но не теряется |

У этого решения тоже есть цена. Расписание теперь живёт в Redis, поэтому Redis должен работать с AOF (Redis в тесте работал с `appendonly yes`). Однако источником истины остаётся Postgres: если Redis потеряет данные, все scheduler'ы можно заново создать из таблицы `pills`. `upsertJobScheduler` идемпотентен, и для 100 тысяч лекарств это заняло 14 секунд.

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

## Выводы

- Cron, который каждую минуту спрашивает «кому это нужно сейчас?», замедляется вместе с ростом данных и не возвращает пропущенную минуту.
- Delayed job хранит время в Redis: воркер просыпается только для наступившего напоминания, а если воркер выключен, напоминание его дожидается.
- Часовые пояса и летнее время считает опция `tz`, а время приёма остаётся в базе в местном времени пользователя.
- Источник истины это Postgres: Redis работает с AOF, `UNIQUE (pill_id, due_at)` останавливает дубликаты, а scheduler'ы можно в любой момент восстановить из таблицы.
