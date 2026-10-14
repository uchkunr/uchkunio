---
title: "Multi-tenancy в NestJS и Postgres 18: изоляция тенантов через Row-Level Security"
date: "2026-08-11"
excerpt: "Один забытый WHERE открывает данные одного клиента другому. Разбираем, как перенести проверку тенанта из кода в базу, какая скрытая ловушка ждёт в пуле соединений и как выглядит полное решение на NestJS."
tags:
  - postgresql
  - nestjs
  - architecture
  - security
---

Самая дорогая ошибка в SaaS редко бывает сложной. Чаще всего это один `WHERE tenant_id = $1`, забытый среди сотен запросов: код проходит ревью, тесты зелёные, а на следующий день один клиент видит счета другого.

Есть три основных подхода к multi-tenancy:

| Подход | Изоляция | Цена |
| --- | --- | --- |
| Отдельная база на каждого тенанта | Полная | Число соединений и миграций растёт вместе с числом тенантов |
| Отдельная схема на каждого тенанта | Сильная | На тысячах схем тяжелеют миграции и системный каталог |
| Общая таблица и `tenant_id` | Ровно настолько, насколько аккуратен код | Самый дешёвый и самый распространённый |

Большинство выбирает третий подход и вместе с ним наследует его слабое место: изоляция держится на памяти разработчика. Row-Level Security (RLS) забирает эту проверку у кода и передаёт её самой базе.

## Политика: проверка на стороне базы

```sql
CREATE TABLE invoices (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid,
  amount     numeric(12,2) NOT NULL
);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoices
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

Текущий тенант хранится в настройке `app.tenant_id`. `USING` определяет, какие строки видны, а `WITH CHECK` определяет, какие строки можно записать. `FORCE` делает политику обязательной и для владельца таблицы. Значение по умолчанию для столбца `tenant_id` берётся из той же настройки, поэтому код его вообще не передаёт. А `uuidv7()` из Postgres 18 выдаёт упорядоченные по времени идентификаторы, так что новые строки записываются в конец индекса.

## Приложение не должно быть суперпользователем

Суперпользователь и роли с атрибутом `BYPASSRLS` обходят любые политики, и даже `FORCE` их не останавливает. Поэтому приложение подключается под отдельной обычной ролью:

```sql
CREATE ROLE app LOGIN PASSWORD '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON invoices TO app;
```

Вот одна и та же таблица под двумя разными ролями:

```text
postgres=# SELECT count(*) FROM invoices;   -- superuser
 3

postgres=> SELECT count(*) FROM invoices;   -- app, тенант не задан
 0
```

Если тенант не задан, приложение не видит ничего. Даже если где-то допущена ошибка, она приводит к пустому ответу, а не к утечке данных. Миграции же выполняются не под `app`, а под владельцем таблицы или суперпользователем.

## Сопротивляется сама база

```text
BEGIN;
SELECT set_config('app.tenant_id', '0199a000-...-00000000000a', true);

SELECT amount FROM invoices;
 100.00
 250.00

INSERT INTO invoices (amount) VALUES (42) RETURNING tenant_id;
 0199a000-0000-7000-8000-00000000000a

INSERT INTO invoices (tenant_id, amount) VALUES ('0199a000-...-00000000000b', 1);
ERROR:  new row violates row-level security policy for table "invoices"
```

`WHERE` нигде не написан, но тенант A видит только свои строки. А попытку записать что-то от его имени в тенант B база отклоняет.

![Интерцептор задаёт тенанта для транзакции, политика RLS возвращает только его строки](/sketches/multi-tenancy/rls.svg)

## Ловушка в пуле соединений

Если задать тенант обычным `SET`, значение останется на соединении. А пул отдаст это соединение следующему запросу:

```text
SET app.tenant_id = '0199a000-...-00000000000b';
SELECT amount FROM invoices;   -- запрос тенанта B
 900.00

SELECT amount FROM invoices;   -- следующий запрос, тенант никто не задавал
 900.00
```

RLS на месте, но теперь он защищает не того тенанта. Решение: `set_config(..., true)`, то есть `SET LOCAL`. В этом случае значение живёт только до конца текущей транзакции. Но после транзакции переменная становится не `NULL`, а пустой строкой, и именно поэтому в политике нужен `NULLIF`:

```text
SELECT count(*) FROM notes;   -- политика без NULLIF, после предыдущей транзакции
ERROR:  invalid input syntax for type uuid: ""
```

## NestJS: каждый запрос в своей транзакции

Тенант берётся из JWT, а не из заголовка, который прислал пользователь. Interceptor оборачивает запрос в транзакцию, а соединение доставляет до репозитория через `AsyncLocalStorage`:

```ts
// tenant-context.ts
import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";

const storage = new AsyncLocalStorage<PoolClient>();

export const runInTenant = <T>(client: PoolClient, fn: () => Promise<T>) => storage.run(client, fn);

export function tenantDb(): PoolClient {
  const client = storage.getStore();
  if (!client) throw new Error("Query outside a tenant transaction");
  return client;
}
```

```ts
// tenant.interceptor.ts
import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from "@nestjs/common";
import type { Pool } from "pg";
import { lastValueFrom, Observable, of } from "rxjs";
import { PG_POOL } from "./database.module";
import { runInTenant } from "./tenant-context";

@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const { user } = context.switchToHttp().getRequest();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [user.tenantId]);
      const result = await runInTenant(client, () => lastValueFrom(next.handle()));
      await client.query("COMMIT");
      return of(result);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
```

В репозитории `tenant_id` не упоминается вовсе:

```ts
@Injectable()
export class InvoicesRepository {
  async findAll() {
    const { rows } = await tenantDb().query("SELECT id, amount FROM invoices ORDER BY id DESC LIMIT 50");
    return rows;
  }

  async create(amount: string) {
    const { rows } = await tenantDb().query("INSERT INTO invoices (amount) VALUES ($1) RETURNING id", [amount]);
    return rows[0];
  }
}
```

Interceptor подключается в модуле глобально: `{ provide: APP_INTERCEPTOR, useClass: TenantInterceptor }`. Работа вне HTTP, например обработка очередей или задачи по cron, идёт через тот же `runInTenant` с явно указанным тенантом.

## Индекс начинается с тенанта

Политика RLS добавляется к каждому запросу как условие `WHERE`, поэтому и индекс должен начинаться с `tenant_id`. Вот сумма по одному тенанту в таблице с 1000 тенантов и 1 миллионом строк:

```sql
CREATE INDEX invoices_tenant_idx ON invoices (tenant_id, id);
```

```text
Без индекса: Parallel Seq Scan, Rows Removed by Filter: 333000   Execution Time: 118.757 ms
С индексом:  Bitmap Index Scan on invoices_tenant_idx           Execution Time: 3.159 ms
```

![Сумма по одному тенанту на 1 млн строк: 118.8 мс последовательным сканированием, 3.2 мс по индексу](/sketches/multi-tenancy/index-race.svg)

Для планировщика `current_setting(...)` в политике выглядит как обычное значение и напрямую попадает в условие индекса. В итоге запрос выполняется в 37 раз быстрее, и при этом в коде приложения не изменилось ни одной строки.
