---
title: "Idempotency key: как не списать деньги дважды при повторной попытке"
date: "2026-09-29"
excerpt: "Если сеть теряет ответ, клиент отправляет запрос повторно, и деньги списываются дважды. С idempotency key пять одновременных повторных попыток превращаются в один платёж."
tags:
  - api-design
  - postgresql
  - payments
  - distributed-systems
---

Клиент отправляет `POST /charge`, сервер списывает деньги, но ответ теряется по дороге: истёк таймаут, оборвалась мобильная сеть или load balancer закрыл соединение. Клиент не знает, прошёл ли платёж, и пробует снова. Без ключа каждая попытка становится новым платежом:

```text
without a key: 5 retries -> 5 payments
```

## Ключ приходит вместе с запросом

Клиент создаёт по одному ключу на каждую логическую операцию и не меняет его ни в одной из повторных попыток:

```http
POST /charge
Idempotency-Key: 7b3e-checkout-A-1001
Content-Type: application/json

{"orderId": "A-1001", "amount": "49.90"}
```

Сервер сохраняет ключ вместе с ответом. Повторный запрос не выполняется заново, а получает сохранённый ответ.

```sql
CREATE TABLE idempotency_keys (
  key          text PRIMARY KEY,
  request_hash text NOT NULL,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

![Пять повторных попыток с одним и тем же ключом доходят до API: одна списывает деньги, четыре получают сохранённый ответ](/sketches/idempotency/retries.svg)

## Одновременные попытки

Самый опасный случай: две попытки приходят одновременно. Подход «сначала проверь, потом запиши» здесь не работает, потому что ключ не найдёт ни одна из них. Поэтому захват ключа мы поручаем уникальному индексу базы:

```ts
return sql.begin(async (tx) => {
  const [claimed] = await tx`
    INSERT INTO idempotency_keys (key, request_hash) VALUES (${key}, ${hash})
    ON CONFLICT (key) DO NOTHING
    RETURNING key`;
  if (!claimed) {
    const [row] = await tx`SELECT request_hash, response FROM idempotency_keys WHERE key = ${key}`;
    if (row.request_hash !== hash) return { status: 422, body: { error: "key reused with a different request" } };
    return { status: 200, body: row.response };
  }
  const [p] = await tx`INSERT INTO payments (order_id, amount) VALUES (${body.orderId}, ${body.amount}) RETURNING id`;
  const response = { paymentId: p.id };
  await tx`UPDATE idempotency_keys SET response = ${JSON.stringify(response)}::text::jsonb WHERE key = ${key}`;
  return { status: 201, body: response };
});
```

Второй `INSERT` ждёт, пока завершится транзакция первого: именно так работает уникальный индекс. После коммита первого `ON CONFLICT DO NOTHING` ничего не возвращает, и второй запрос читает готовый ответ. Вот пять запросов, отправленных одновременно с одним и тем же ключом:

```text
201 {"paymentId":"1"}
200 {"paymentId":"1"} (replayed)
200 {"paymentId":"1"} (replayed)
200 {"paymentId":"1"} (replayed)
200 {"paymentId":"1"} (replayed)
with a key: 5 retries -> 1 payment
```

![Первый запрос захватывает ключ и списывает деньги; повторная попытка с тем же ключом получает сохранённый ответ](/sketches/idempotency/flow.svg)

## Три правила

Первое: `request_hash` защищает от использования одного ключа для другого запроса:

```text
{"status":422,"body":{"error":"key reused with a different request"}}
```

Второе: тот же ключ должен получить и платёжный провайдер. Провайдеры вроде Stripe принимают заголовок `Idempotency-Key`: если сервер отправит запрос провайдеру и упадёт, не успев сохранить ответ, следующая попытка не спишет деньги повторно и на стороне провайдера. В этом примере вызов провайдера упрощён: в реальной системе долгий внешний вызов выполняется не внутри транзакции базы, а управляется через состояния `processing` и `done`.

Третье: ключи не хранятся вечно, обычно достаточно суток:

```sql
DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours';
```
