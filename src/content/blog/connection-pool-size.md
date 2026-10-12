---
title: "Connection pool hajmi: 100 ta ulanish nega 10 tadan sekinroq"
date: "2026-09-22"
excerpt: "Pool'ni kattalashtirish bazani tezlashtirmaydi. 2 yadroli Postgres'da 100 ta ulanish 10 tasiga qaraganda 5.4 barobar kam tranzaksiya bajardi va 54 barobar sekinroq javob berdi."
tags:
  - postgresql
  - performance
  - connection-pooling
---

Servis sekinlashganda birinchi bo'lib qo'l uriladigan sozlama ko'pincha pool hajmi bo'ladi: 10 ni 100 ga ko'taramiz, ko'proq so'rov parallel ishlaydi, demak hammasi tezlashadi. Postgres'da bu mantiq teskari natija beradi.

## O'lchov

Postgres 18, 2 CPU bilan cheklangan konteyner. pgbench boshqa konteynerdan, standart TPC-B yuklamasi bilan ishlaydi: har bir tranzaksiyada bir nechta `UPDATE`, `SELECT` va `INSERT` bor.

```bash
pgbench -i -s 10 postgres
pgbench -c 10  -j 4 -T 15 postgres
pgbench -c 100 -j 4 -T 15 postgres
```

| Ulanishlar | TPS | O'rtacha kechikish |
| --- | --- | --- |
| 10 | 3614 | 2.8 ms |
| 100 | 665 | 150.5 ms |
| 200 | 689 | 290.3 ms |

O'n barobar ko'p ulanish 5.4 barobar kam ish bajardi va 54 barobar sekin javob berdi.

![2 CPU'dagi Postgres: TPC-B va faqat o'qish yuklamasida 10, 100 va 200 ulanishdagi TPS](/sketches/pool/throughput.svg)

## Nega bunday bo'ladi

Postgres har bir ulanish uchun alohida jarayon ochadi. 2 yadroda bir vaqtda ko'pi bilan ikkita jarayon ishlaydi, qolganlari navbat kutadi, operatsion tizim esa ular orasida tinimsiz almashib turadi. Bundan tashqari, TPC-B'da atigi 10 ta filial qatori bor va har bir tranzaksiya ulardan birini yangilaydi: 100 ta ulanish o'sha 10 ta qator lock'i uchun bir-birini kutadi.

Faqat o'qish (`-S`) yuklamasida qator lock'lari yo'q, lekin manzara shunga o'xshash:

| Ulanishlar | TPS | O'rtacha kechikish |
| --- | --- | --- |
| 10 | 6561 | 1.5 ms |
| 100 | 5837 | 17.1 ms |
| 200 | 5339 | 37.5 ms |

O'tkazuvchanlik oshmadi, kechikish esa 11 barobar o'sdi. Qo'shimcha ulanishlar ishni tezlashtirmaydi, ular faqat navbatni ilovadan bazaning ichiga ko'chiradi, u yerda esa navbat qimmatroq: kutayotgan so'rov CPU vaqti va xotira egallaydi.

![TPC-B tranzaksiyasining o'rtacha kechikishi: 10 ulanishda 2.8 ms, 100 ulanishda 150.5 ms](/sketches/pool/latency-race.svg)

## Pool qancha bo'lishi kerak

PostgreSQL wiki'dagi boshlang'ich formula: `yadrolar × 2 + disklar`. 2 yadroli serverda bu 5 atrofida. Keyin o'lchov hal qiladi: TPS o'sishdan to'xtagan nuqtadan keyingi har bir ulanish faqat kechikish qo'shadi.

Bu son butun baza uchun, servis nusxalari soniga bo'linmaydi. 10 ta pod har birida `max: 20` bilan bazaga 200 ta ulanish ochadi. Bunday holatda servis va baza o'rtasiga PgBouncer qo'yiladi: ilovalar minglab ulanish ochishi mumkin, bazaga esa transaction rejimida o'nlab ulanish boradi.

```ini
[pgbouncer]
pool_mode = transaction
default_pool_size = 10
max_client_conn = 2000
```

Transaction rejimida ulanish faqat tranzaksiya davomida ilovaga tegishli bo'ladi, shuning uchun sessiyaga bog'langan sozlamalar ishlamaydi. [Multi-tenancy maqolasidagi](/blog/multi-tenancy-with-row-level-security) `set_config(..., true)` bu rejimda ham to'g'ri ishlaydi, oddiy `SET` esa yo'q.
