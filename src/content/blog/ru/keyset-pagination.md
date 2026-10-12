---
title: "Keyset pagination: пагинация в 1800 раз быстрее OFFSET"
date: "2026-09-15"
excerpt: "С OFFSET каждая следующая страница отдаётся медленнее предыдущей, потому что Postgres читает и те строки, которые потом отбрасывает. Keyset pagination возвращает даже 49 501-ю страницу так же быстро, как первую."
tags:
  - postgresql
  - performance
  - api-design
---

Во многих API пагинацию пишут так:

```sql
SELECT id, created_at FROM events
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 990000;
```

Первые страницы открываются быстро, поэтому на тестах проблема не видна. На таблице в 1 миллион строк с индексом по `(created_at, id)`:

```text
OFFSET 0:       0.041 ms
OFFSET 100000:  8.653 ms
OFFSET 990000: 84.783 ms
```

Время растёт линейно вместе с номером страницы. Причину показывает план:

```text
Limit (actual rows=20)
  ->  Index Only Scan using events_created_idx on events (actual rows=990020)
```

Чтобы вернуть 20 строк, Postgres читает из индекса 990 020 записей и 990 000 из них отбрасывает. OFFSET не знает, откуда начинать: он знает только, сколько записей нужно пропустить.

![OFFSET ради 20 строк читает 990 020 записей индекса, а keyset сразу переходит к курсору и читает 20](/sketches/keyset/offset-vs-keyset.svg)

## Продолжение с последней просмотренной строки

В keyset pagination вместо номера страницы запоминается последняя строка предыдущей страницы, и следующий запрос начинается именно с неё:

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

Postgres переходит в индексе прямо к курсору и читает только 20 записей. В результате получаются ровно те же строки, что и с OFFSET 990000, но в 1800 раз быстрее.

![49 501-я страница таблицы в 1 миллион строк: OFFSET 84.8 мс, keyset 0.047 мс](/sketches/keyset/race.svg)

Решающих деталей две. Первая: `id` входит в сортировку. Если есть строки с одинаковым `created_at`, порядок становится неоднозначным, и строки повторяются на двух страницах или вовсе выпадают. Вторая: сравнение кортежей `(created_at, id) < (...)` полностью совпадает с порядком индекса, поэтому Postgres использует его как одно `Index Cond`. Условие `created_at < $1 OR (created_at = $1 AND id < $2)` логически эквивалентно, но может и не превратиться в один поиск по индексу.

## В API

Клиент получает курсор в виде непрозрачной строки, заглядывать внутрь которой ему не нужно:

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

Ограничение у keyset одно: сразу перейти на 37-ю страницу нельзя, можно только двигаться вперёд или назад. Для бесконечной ленты, открытого API и экспорта это правильный выбор. А для таблиц в админке с номерами страниц, если данных немного, вполне хватает OFFSET.
