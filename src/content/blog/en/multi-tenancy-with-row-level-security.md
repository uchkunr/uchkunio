---
title: "Multi-tenancy in NestJS and Postgres 18: isolating tenants with Row-Level Security"
date: "2026-08-11"
excerpt: "A single forgotten WHERE exposes one customer's data to another. This post moves the tenant check from application code into the database, explains a hidden trap in the connection pool, and builds a complete solution in NestJS."
tags:
  - postgresql
  - nestjs
  - architecture
  - security
---

The most expensive mistake in a SaaS product is rarely a complicated one. More often it is a single `WHERE tenant_id = $1` forgotten among hundreds of queries: the code passes review, the tests are green, and the next day one customer sees another customer's invoices.

There are three main approaches to multi-tenancy:

| Approach | Isolation | Cost |
| --- | --- | --- |
| A separate database per tenant | Complete | Connections and migrations multiply with the number of tenants |
| A separate schema per tenant | Strong | With thousands of schemas, migrations and the catalog become heavy |
| A shared table with `tenant_id` | Only as strong as the code is careful | The cheapest and the most common |

Most teams choose the third option and inherit its weakness along with it: isolation depends on the developer's memory. Row-Level Security (RLS) takes this check out of the code and hands it to the database itself.

## The policy: the check lives in the database

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

The current tenant is stored in the `app.tenant_id` setting. `USING` determines which rows are visible, and `WITH CHECK` determines which rows may be written. `FORCE` makes the policy binding on the table owner as well. The `tenant_id` column takes its default value from the same setting, so the code never passes it at all. Finally, `uuidv7()` in Postgres 18 produces time-ordered identifiers, so new rows are written to the end of the index.

## The application must not be a superuser

Superusers and roles with the `BYPASSRLS` attribute bypass every policy, and `FORCE` does not stop them either. The application connects with a separate, ordinary role:

```sql
CREATE ROLE app LOGIN PASSWORD '...';
GRANT SELECT, INSERT, UPDATE, DELETE ON invoices TO app;
```

Here is the same table seen through two different roles:

```text
postgres=# SELECT count(*) FROM invoices;   -- superuser
 3

postgres=> SELECT count(*) FROM invoices;   -- app, no tenant set
 0
```

When no tenant is set, the application sees nothing. Even when something goes wrong, the result is an empty response rather than a data leak. Migrations, on the other hand, run as the table owner or a superuser, not as `app`.

## The database itself pushes back

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

There is no `WHERE` anywhere, yet tenant A sees only its own rows. When it tries to write a row for tenant B under its own identity, the database rejects the attempt.

![The interceptor sets the tenant for the transaction; the RLS policy returns only that tenant's rows](/sketches/multi-tenancy/rls.svg)

## The connection pool trap

If you set the tenant with a plain `SET`, the value stays attached to the connection. The pool then hands that same connection to the next request:

```text
SET app.tenant_id = '0199a000-...-00000000000b';
SELECT amount FROM invoices;   -- tenant B's request
 900.00

SELECT amount FROM invoices;   -- next request, nobody set a tenant
 900.00
```

RLS is still in place, but it is now protecting the wrong tenant. The fix is `set_config(..., true)`, which is equivalent to `SET LOCAL`. With it, the value lives only for the duration of the current transaction. After the transaction ends, however, the variable is left as an empty string rather than `NULL`, and that is exactly why the policy needs `NULLIF`:

```text
SELECT count(*) FROM notes;   -- policy without NULLIF, after an earlier transaction
ERROR:  invalid input syntax for type uuid: ""
```

## NestJS: every request in its own transaction

The tenant is taken from the JWT, never from a header the user sends. An interceptor wraps the request in a transaction and makes the connection available to the repository through `AsyncLocalStorage`:

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

The repository does not mention `tenant_id` at all:

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

The interceptor is registered globally in the module with `{ provide: APP_INTERCEPTOR, useClass: TenantInterceptor }`. Work that runs outside HTTP, such as queue consumers or cron jobs, goes through the same `runInTenant` and names the tenant explicitly.

## The index starts with the tenant

The RLS policy is added to every query as a `WHERE` condition, so the index has to start with `tenant_id` as well. Here is the sum for a single tenant in a table with 1000 tenants and 1 million rows:

```sql
CREATE INDEX invoices_tenant_idx ON invoices (tenant_id, id);
```

```text
Without index: Parallel Seq Scan, Rows Removed by Filter: 333000   Execution Time: 118.757 ms
With index:    Bitmap Index Scan on invoices_tenant_idx            Execution Time: 3.159 ms
```

![Sum for one tenant on 1M rows: 118.8 ms with a sequential scan, 3.2 ms with an index](/sketches/multi-tenancy/index-race.svg)

To the planner, the `current_setting(...)` call in the policy looks like a plain value, so it goes straight into the index condition. The query becomes 37 times faster without a single line of the application changing.
