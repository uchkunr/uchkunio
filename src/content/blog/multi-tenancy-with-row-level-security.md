---
title: "NestJS va Postgres 18'da multi-tenancy: tenantlarni Row-Level Security bilan ajratish"
date: "2026-10-12"
excerpt: "Bitta unutilgan WHERE bir mijozning ma'lumotini boshqasiga ochib beradi. Tenant tekshiruvini koddan bazaga ko'chirish, connection pool'dagi yashirin tuzoq va NestJS'dagi to'liq yechim."
tags:
  - postgresql
  - nestjs
  - architecture
  - security
---

SaaS'dagi eng qimmat xato kamdan-kam murakkab bo'ladi. Ko'pincha u yuzlab so'rov orasida unutilgan bitta `WHERE tenant_id = $1` dir: kod review'dan o'tadi, testlar yashil, ertasiga esa bir mijoz boshqasining hisob-fakturalarini ko'radi.

Multi-tenancy'ning uch asosiy yo'li bor:

| Yondashuv | Ajratish | Narxi |
| --- | --- | --- |
| Har tenantga alohida baza | To'liq | Ulanishlar va migratsiyalar tenantlar soniga ko'payadi |
| Har tenantga alohida schema | Kuchli | Minglab schema'da migratsiya va katalog og'irlashadi |
| Umumiy jadval va `tenant_id` | Kod qanchalik ehtiyotkor bo'lsa, shunchalik | Eng arzon, eng ko'p tarqalgan |

Ko'pchilik uchinchisini tanlaydi va uning zaif joyini ham meros qilib oladi: ajratish dasturchining xotirasiga bog'liq. Row-Level Security (RLS) bu tekshiruvni koddan olib, bazaning o'ziga topshiradi.

## Siyosat: tekshiruv bazada

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

Joriy tenant `app.tenant_id` sozlamasida saqlanadi. `USING` qaysi qatorlar ko'rinishini, `WITH CHECK` esa qaysilarini yozish mumkinligini belgilaydi. `FORCE` siyosatni jadval egasiga ham majburiy qiladi. `tenant_id` ustunining standart qiymati shu sozlamadan olinadi, shuning uchun kod uni umuman uzatmaydi. Postgres 18 dagi `uuidv7()` esa vaqt bo'yicha tartiblangan identifikator beradi va yangi qatorlar indeksning oxiriga yoziladi.

## Ilova superuser bo'lmasligi kerak

Superuser va `BYPASSRLS` huquqli rollar har qanday siyosatni chetlab o'tadi, `FORCE` ham ularni to'xtatmaydi. Ilova alohida, oddiy rol bilan ulanadi:

```sql
CREATE ROLE app LOGIN PASSWORD '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON invoices TO app;
```

Bir xil jadval, ikki xil rol:

```text
postgres=# SELECT count(*) FROM invoices;   -- superuser
 3

postgres=> SELECT count(*) FROM invoices;   -- app, tenant berilmagan
 0
```

Tenant berilmasa, ilova hech narsani ko'rmaydi. Xato bo'lsa ham, u ma'lumot oqishiga emas, bo'sh javobga olib keladi. Migratsiyalar esa `app` bilan emas, jadval egasi yoki superuser bilan bajariladi.

## Bazaning o'zi qarshilik qiladi

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

`WHERE` yozilmagan, lekin tenant A faqat o'z qatorlarini ko'radi. Uning nomidan tenant B'ga yozish urinishini esa baza rad etadi.

## Connection pool'dagi tuzoq

Tenantni oddiy `SET` bilan bersangiz, qiymat ulanishda qolib ketadi. Pool shu ulanishni keyingi so'rovga beradi:

```text
SET app.tenant_id = '0199a000-...-00000000000b';
SELECT amount FROM invoices;   -- tenant B'ning so'rovi
 900.00

SELECT amount FROM invoices;   -- keyingi so'rov, tenant hech kim bermagan
 900.00
```

RLS bor, lekin u endi boshqa tenantni himoya qilmoqda. Yechim: `set_config(..., true)`, ya'ni `SET LOCAL`. Bunda qiymat faqat joriy tranzaksiya davomida yashaydi. Tranzaksiyadan keyin esa o'zgaruvchi `NULL` emas, bo'sh satr bo'lib qoladi, siyosatdagi `NULLIF` aynan shu sababli kerak:

```text
SELECT count(*) FROM notes;   -- NULLIF'siz siyosat, oldingi tranzaksiyadan keyin
ERROR:  invalid input syntax for type uuid: ""
```

## NestJS: har bir so'rov o'z tranzaksiyasida

Tenant JWT'dan olinadi, foydalanuvchi yuborgan header'dan emas. Interceptor so'rovni tranzaksiyaga o'raydi, ulanishni esa `AsyncLocalStorage` orqali repozitoriyga yetkazadi:

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

Repozitoriyda `tenant_id` umuman tilga olinmaydi:

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

Interceptor modulda global qilib ulanadi: `{ provide: APP_INTERCEPTOR, useClass: TenantInterceptor }`. Navbat yoki cron kabi HTTP'dan tashqaridagi ishlar ham xuddi shu `runInTenant` orqali, tenantni aniq ko'rsatib ishlaydi.

## Indeks tenant bilan boshlanadi

RLS siyosati har bir so'rovga `WHERE` sifatida qo'shiladi, shuning uchun indeks ham `tenant_id` dan boshlanishi kerak. 1000 tenant va 1 million qatorli jadvalda bitta tenantning yig'indisi:

```sql
CREATE INDEX invoices_tenant_idx ON invoices (tenant_id, id);
```

```text
Indekssiz:  Parallel Seq Scan, Rows Removed by Filter: 333000   Execution Time: 118.757 ms
Indeks bilan: Bitmap Index Scan on invoices_tenant_idx           Execution Time: 3.159 ms
```

Siyosatdagi `current_setting(...)` planner uchun oddiy qiymatdek ko'rinadi va indeks shartiga to'g'ridan-to'g'ri tushadi: 37 barobar tezroq, ilovada bitta ham qator o'zgarmagan holda.
