---
title: "RingCentral orqali kuniga 5 mln SMS: rate limit, priority va tenantlararo adolat"
date: "2026-10-15"
excerpt: "Har bir extension uchun daqiqasiga 40 so'rov limiti, 1000 ta tenant va kutib turmasligi kerak bo'lgan birinchi xabarlar bitta BullMQ limiter'iga sig'maydi. Durability, scheduling va rate limiting'ni alohida qatlamlarga ajratganda nima kafolatlanadi va nima kafolatlanmaydi."
tags:
  - architecture
  - distributed-systems
  - postgresql
  - kafka
  - rate-limiting
---

Platformada 1000 ta tenant bor va har biri RingCentral orqali SMS yuboradi. Xabarlar ikki xil: birinchi va to'g'ridan-to'g'ri xabarlar (first/direct), ular kutib turmasligi kerak, hamda minglab qabul qiluvchiga ketadigan bulk kampaniyalar. RingCentral esa har bir extension va app juftligi uchun daqiqasiga 40 ta so'rovga ruxsat beradi, API'ni chaqiradigan pod'lar esa bir nechta.

Bu vazifada bir-biridan mustaqil uchta masala bor:

1. **Durability.** SMS yuborish topshirig'i Redis yoki pod qayta ishga tushganda yo'qolmasligi kerak.
2. **Scheduling.** Qaysi tenant va qaysi SMS navbatdagi bo'lishini aniqlash kerak.
3. **Rate limiting.** Bitta extension va app juftligi uchun barcha pod'lar birgalikda 40 so'rov/daqiqa limitidan oshmasligi kerak.

Uchalasini bitta BullMQ queue limiter'iga yuklash shart emas. BullMQ worker'larni ishga tushirish va fon vazifalari uchun qolishi mumkin, lekin yuborish tartibi va limit holati undan mustaqil boshqarilishi kerak.

## Arxitektura

```text
NestJS API             first/direct message, bulk campaign
    |
    v
PostgreSQL             sms_outbox, campaign recipients, delivery state, idempotency keys
    |                  (source of truth; transactional outbox yoki CDC)
    v
Kafka                  durable transport, replay, consumer group'lar
    |
    v
Scheduler              priority lane (first + direct) | bulk lane (tenantlar bo'yicha fair)
                       per-extension eligibility, token bucket yoki pacing, lease
    |
    v
RingCentral API        har bir extension + app uchun alohida rate limit
```

Rollar aniq ajratilgan: Kafka xabarlarni yetkazadi va qayta o'qishga imkon beradi, PostgreSQL esa qaysi SMS yuborilishi kerakligining ishonchli holatini saqlaydi. Redis'dagi queue butunlay yo'qolsa ham, yuborilmagan SMS'lar yo'qolmasligi kerak.

## Per-extension rate limiter

RingCentral limiti bitta kalit bo'yicha hisoblanadi:

```text
rate_limit_key = (ringcentral_account_id, extension_id, app_id, api_usage_group)
```

RingCentral hujjatiga ko'ra limit autentifikatsiyadan o'tgan foydalanuvchi, app va API guruhi juftligiga qo'llanadi. Medium guruhi uchun standart limit 40 so'rov/daqiqa, sliding window bo'yicha hisoblanadi, `/sms` endpoint'i ham shu guruhda. Limit oshib ketsa, server 60 soniyalik penalty davomida shu guruhdagi barcha so'rovlarni rad etadi va har bir yangi so'rov penalty'ni qaytadan boshlaydi.

### Nega 40 emas, 35

40/daqiqa bu yuqori chegara, xavfsiz ish rejimi emas. Agar har bir pod bitta extension uchun mustaqil ravishda 40 tadan yuborsa, limit darhol buziladi. Boshlang'ich sozlama:

- RingCentral limiti: 40 so'rov/60 soniya.
- Ichki maqsad: 35 so'rov/60 soniya.
- Bitta extension uchun bir vaqtda faqat 1 ta faol SMS POST.
- `Retry-After` kelsa, shu muddat davomida o'sha kalit bo'yicha yangi POST yuborilmaydi.

35 atigi konservativ boshlang'ich qiymat, uni kuzatuv natijalariga qarab o'zgartirish mumkin. Qat'iy kafolat kerak bo'lsa, RingCentral'ning sliding window'iga mos keladigan markazlashgan scheduler zarur.

### Holat qayerda saqlanadi: Redis yoki PostgreSQL

| Yondashuv | Afzalligi | Xavfi |
| --- | --- | --- |
| Redis Lua va distributed lock | Tez, token atomik ajratiladi | Restart yoki failover'da holat yo'qolishi yoki eskisi tiklanishi mumkin |
| PostgreSQL tranzaksiya va row lock | Durable, barcha pod'lar uchun umumiy | Katta hajmda contention va bazaga qo'shimcha yuk |
| Har bir extension kaliti uchun bitta dispatcher | Tushunarli, tartibni boshqarish oson | Extension ko'p bo'lsa, partition va ownership boshqaruvi kerak |

Men scheduling holatini PostgreSQL'da saqlashni, extension bo'yicha lease va ownership'ni hamda markazlashgan admission control'ni tanlayman. Redis faqat tezlashtiruvchi qatlam bo'lishi mumkin, tizimning ishonchliligi esa Redis holatiga bog'liq bo'lmasligi kerak.

```sql
CREATE TABLE sms_rate_limit_state (
  account_id      text        NOT NULL,
  extension_id    text        NOT NULL,
  app_id          text        NOT NULL,
  api_group       text        NOT NULL DEFAULT 'medium',
  next_allowed_at timestamptz NOT NULL DEFAULT now(),
  blocked_until   timestamptz,
  lease_owner     text,
  lease_until     timestamptz,
  PRIMARY KEY (account_id, extension_id, app_id, api_group)
);
```

Bu jadvalning o'zi yetarli emas. `next_allowed_at` faqat pacing uchun ishlaydi: 35/daqiqada so'rovlar orasidagi minimal interval 60 / 35, ya'ni taxminan 1.714 soniya. Aniq sliding window limit uchun esa oxirgi so'rovlarning vaqtlari yoki shunga teng atomik holat ham kerak. Har bir extension'ning o'z navbati bor va boshqa extension'lar undan mustaqil ishlaydi.

### Parallel pod'lar

Bitta extension'ga bir vaqtda bir nechta pod so'rov yuborish huquqiga ega bo'lmasligi kerak. Buni distributed lease va fencing token bilan boshqarish mumkin:

1. Dispatcher extension uchun lease oladi.
2. Scheduler navbatdagi xabarni tanlaydi.
3. Atomik operatsiyada so'rov uchun slot band qilinadi.
4. HTTP POST bajariladi.
5. Natija durable holatga yoziladi.

Biroq lease muddati tugagan paytda eski pod hali HTTP so'rov yuborayotgan bo'lishi mumkin. Fencing token'ni RingCentral API'ning o'zi tekshirmaydi, shuning uchun u tashqi POST'ni to'liq himoya qilmaydi. Lease, in-flight so'rov timeout'i va ownership almashish protokoli birgalikda loyihalanishi kerak.

## Priority va bulk bir-biriga xalaqit bermasligi

Priority navbatni chetlab o'tishi mumkin, lekin extension'ning umumiy rate limitini chetlab o'tolmaydi. Shuning uchun har bir extension uchun ikkita mantiqiy navbat bo'ladi: `priority_queue` (first va direct xabarlar) va `bulk_queue` (kampaniya SMS'lari).

```text
dispatch(extension):
    if now < blocked_until:
        return
    if request_slot_not_available:
        return

    if priority_queue has eligible message:
        message = priority_queue.pop()
    else:
        message = fair_scheduler.next_bulk_message()

    if message exists:
        reserve_rate_limit_slot()
        submit_to_ringcentral(message)
```

Priority faqat bulk xabar uchun HTTP POST hali boshlanmagan bo'lsa oldinga o'tadi. RingCentral'ga ketayotgan so'rovni priority xabar kelgani uchun ortga qaytarib bo'lmaydi.

Extension'ning 35 so'rov/daqiqalik ichki budjetini quyidagicha taqsimlash mumkin:

- 5 so'rov/daqiqa priority xabarlar uchun rezerv.
- 30 so'rov/daqiqa bulk uchun asosiy budjet.
- Priority ishlatilmayotganda bo'sh quvvat bulk'ka beriladi, lekin priority kelishi bilan darhol qaytariladi.

Bu misol, universal optimal qiymat emas. Asosiy shart shuki, bulk butun limitni egallab olmasin. Priority trafik rezervdan ham oshsa, u ham limit doirasida kutadi: 40/daqiqa ichida hech bir scheduler barcha priority xabarlarni darhol yuborishni kafolatlay olmaydi.

## Tenantlararo adolat: global FIFO emas

1000 ta tenantning har biri 5000 tadan SMS yuborsa, bulk hajmi kuniga 5 mln SMS bo'ladi. Global FIFO'da birinchi tenantning 5000 ta SMS'i qolganlarning hammasini orqaga suradi. Shuning uchun bulk uchun Deficit Round Robin (DRR) yoki Weighted Fair Queuing kabi scheduler kerak: har bir aylanishda faol tenantlar navbat bilan bittadan imkoniyat oladi. Tenant A'da yana minglab xabar bo'lsa ham, B va C uning tugashini kutmaydi.

Amaliy qoidalar:

1. Har bir tenantning bulk navbati alohida.
2. Scheduler'da faqat faol tenantlar qatnashadi.
3. Scheduler tenantlar bo'yicha navbat bilan xabar tanlaydi.
4. Tenantning extension limiti vaqtincha band bo'lsa, scheduler keyingi tayyor tenantga o'tadi.
5. Tanlangan har bir xabar baribir o'z extension'ining rate limiter'idan o'tadi.

Adolat ikki darajada ishlaydi. Tenant darajasida katta kampaniya boshqa tenantlarni cheksiz kutdirmaydi. Extension darajasida esa priority va bulk bitta rate limit kalitini bo'lishadi. Extension'lar soni va ularning limitlari teng bo'lmasa, oddiy round robin tenantlarga teng throughput bermaydi: tenantlarga teng ulush kerakmi yoki extension'larga teng imkoniyat, bu alohida biznes qarori.

## Bulk yo'qolmasligi uchun

BullMQ va Kafka'da persistent sozlamalar yoqilgan bo'lishi foydali, lekin talabni faqat Redis queue'ga topshirib bo'lmaydi. Haqiqat manbai PostgreSQL bo'ladi. Kampaniya yaratilganda:

1. Kampaniya va uning qabul qiluvchilari PostgreSQL'ga yoziladi.
2. Shu tranzaksiya ichida outbox event yaratiladi.
3. Outbox publisher event'larni Kafka'ga chiqaradi.
4. Consumer SMS'larni dispatch uchun tayyorlaydi.
5. Redis yoki Kafka vaqtincha ishlamasa, bajarilmagan ishlar PostgreSQL'da qoladi va keyin qayta ishlanadi.

```sql
CREATE TABLE sms_outbox (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  extension_id    text        NOT NULL,
  campaign_id     uuid,
  idempotency_key text        NOT NULL UNIQUE,
  message_type    text        NOT NULL,
  payload         jsonb       NOT NULL,
  status          text        NOT NULL DEFAULT 'pending',
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

`status` uchun kamida quyidagi holatlar kerak:

| Holat | Ma'nosi |
| --- | --- |
| `pending` | Yuborishni kutmoqda |
| `claimed` | Dispatcher ishni o'z zimmasiga oldi |
| `sending` | Tashqi so'rov bajarilmoqda |
| `accepted` | RingCentral so'rovni qabul qildi |
| `retry_wait` | Qayta urinish vaqtini kutmoqda |
| `unknown` | So'rov natijasi noaniq |
| `failed_permanent` | Qayta urinish bilan tuzalmaydigan xato |

`claimed` holatida qolib ketgan ishlarni lease muddati tugagach qayta tiklash mumkin. `sending` holatidagi ishni esa avtomatik qayta yuborishdan oldin tashqi so'rovning natijasini aniqlash kerak. Shu tariqa Redis'dagi barcha queue'lar o'chib ketsa ham, PostgreSQL'dagi `pending` va tiklanadigan ishlar qayta navbatga qo'yiladi.

## Bitta SMS ikki marta ketmasligi

Arxitekturaning eng qattiq cheklovi shu yerda. PostgreSQL'dagi idempotency key faqat tizim ichida takroriy ish yaratilishining oldini oladi, RingCentral orqali SMS ikki marta ketmasligini esa kafolatlamaydi:

1. Worker RingCentral'ga POST yuboradi.
2. RingCentral SMS'ni qabul qiladi.
3. Javob tarmoqda yo'qoladi yoki worker crash bo'ladi.
4. PostgreSQL'da xabar `accepted` deb belgilanmay qoladi.
5. Worker ishni qayta yuboradi va SMS ikkinchi marta ketadi.

Oddiy HTTP POST tashqi tizimda idempotentlikni kafolatlamaydi. Buning uchta yo'li bor:

- **Provider idempotency key'ni qo'llasa.** Har bir mantiqiy SMS uchun barqaror key yaratiladi va barcha retry'larda shu key ishlatiladi. Bunga faqat endpoint bu mexanizmni rasman qo'llashi tasdiqlangandan keyin tayanish mumkin.
- **Natija noaniq bo'lsa, avval reconciliation.** Xabar `unknown` holatiga o'tadi, RingCentral message store'da tekshiriladi va qaror faqat natija aniq bo'lgandan keyin qabul qilinadi. Xabarning topilmagani uning yuborilmaganini har doim ham isbotlamaydi.
- **Provider idempotentlik bermasa.** Tanlash kerak: noaniq holatda avtomatik retry qilib, yo'qolish xavfini kamaytirish yoki qayta yubormasdan, takror xavfini kamaytirish.

Provider bilan idempotent protokol yoki ishonchli reconciliation bo'lmasa, "hech qachon yo'qolmaydi" va "hech qachon takrorlanmaydi" degan ikki kafolatni bir vaqtda berib bo'lmaydi. Shuning uchun `unknown` holati alohida saqlanadi va avtomatik retry faqat natija aniq bo'lganda bajariladi. Biznes uchun takror mutlaqo mumkin bo'lmasa, noaniq holat avtomatik qayta yuborilmaydi, balki alohida tekshiruvga chiqariladi.

## 429 bilan ishlash

RingCentral hujjatiga ko'ra, `Retry-After` qayta urinishgacha kutish kerak bo'lgan soniyalarni bildiradi, u bo'lmasa kamida 30 soniya kutish tavsiya qilinadi. Penalty paytida yuborilgan har bir so'rov penalty'ni qaytadan boshlaydi.

```text
onRateLimitResponse(extensionKey, response):
    if response.status == 429:
        retryAt = now + RetryAfter(response)
        persistBlockedUntil(extensionKey, retryAt)
        releaseWorker()
        return

    if response.success:
        persistAcceptedState()
        updateRateLimitTelemetry()
```

Bunda quyidagilarga e'tibor berish kerak:

- `Retry-After` soniyalar yoki HTTP-date bo'lishi mumkin, ikkalasi ham to'g'ri parse qilinadi.
- `blocked_until` pod xotirasida emas, durable saqlanadi.
- Bitta extension uchun 429 kelsa, shu kalitdagi barcha dispatcher'lar yangi POST'ni to'xtatadi.
- Worker `sleep()` bilan band qilib qo'yilmaydi: keyingi urinish `next_attempt_at` yoki delayed job orqali rejalashtiriladi.
- Header'lar har bir javobda yangilanadi: `X-Rate-Limit-Remaining` nolga tushsa, `X-Rate-Limit-Window` bo'yicha kutiladi.
- `503`, timeout va tarmoq xatolari `429` bilan bir xil emas: ularning retry va noaniq natija siyosati boshqa.

429'da butun tizimni pauza qilish xato. Faqat tegishli rate limit kaliti bloklanadi, qolgan extension'lar ishlashda davom etadi.

## Kuniga 5 mln SMS: quvvat hisobi

| Ko'rsatkich | Qiymat |
| --- | --- |
| Kunlik bulk | 5 000 000 SMS |
| O'rtacha tezlik, butun tizim | 57.9 SMS/soniya |
| Nazariy agregat, 1000 extension × 35/daqiqa | 35 000 SMS/daqiqa |
| Bitta extension quvvati, 35/daqiqada | 2100 SMS/soat |
| Bitta extension uchun 5000 SMS | 143 daqiqa, ya'ni 2 soat 23 daqiqa |

Hisob 1000 ta mustaqil extension, har biri uchun 35 so'rov/daqiqa va har bir POST bitta SMS degan farazga asoslangan. Bu nazariy quvvat, kafolatlangan throughput emas. Agar 1000 ta extension bir vaqtda kampaniya boshlasa, bu endi scheduler masalasi emas, quvvat masalasi. Real natija priority trafikka, Medium guruhidagi boshqa API chaqiruvlariga, provider'ning qo'shimcha cheklovlariga va kampaniya qaysi vaqt oralig'ida tugashi kerakligiga bog'liq.

Yana ikki narsani hisobga olish kerak. Birinchisi, API so'rovlari soni va SMS qabul qiluvchilar soni bir xil tushuncha emas: bitta POST bir nechta qabul qiluvchini olsa, ikkalasini alohida hisoblash kerak. Ikkinchisi, RingCentral ommaviy va avtomatik xabarlar (kampaniyalar, eslatmalar) uchun alohida mahsulot, High Volume SMS'ni taklif qiladi: u bitta raqamdan kuniga 250 000 tagacha SMS va bitta API so'rovida 10 000 tagacha SMS yuborishga imkon beradi. Kampaniyalarni qaysi API orqali yuborish ham limitlarni, ham yuqoridagi hisobni o'zgartiradi.

## Production'ga chiqarish bosqichlari

1. **PostgreSQL durability.** Outbox, idempotency constraint, state machine, lease recovery va `pending` ishlarni qayta tiklash.
2. **Per-extension dispatcher.** Barcha pod'lar uchun umumiy rate limit holati, yagona ownership va `Retry-After` bo'yicha durable bloklash.
3. **Priority va fairness.** First/direct uchun yuqori ustuvorlik, bulk uchun DRR va priority rezervi.
4. **Failure testing.** Redis restart, pod crash, Kafka consumer rebalance, PostgreSQL failover, 429, timeout va HTTP javobi yo'qolgan holatlar.
5. **Observability.** Har bir extension uchun so'rov tezligi, qolgan kvota, 429 soni, priority kutish vaqti, bulk backlog yoshi, `unknown` holatlar soni va retry statistikasi.

## Xulosa

- PostgreSQL yuborish holatining haqiqat manbai, Kafka transport va replay, Redis va BullMQ esa faqat tezkor bajarish qatlami: ishonchlilik kafolati ularga bog'liq emas.
- Rate limit har bir extension kaliti bo'yicha barcha pod'lar uchun umumiy, durable holatda boshqariladi: 40 emas, 35 so'rov/daqiqa, bir vaqtda bitta POST va `Retry-After` bo'yicha bloklash.
- Priority bulk'dan oldin o'tadi, lekin limitni chetlab o'tmaydi. Tenantlar orasida esa global FIFO emas, DRR ishlaydi.
- Ochiq masala bitta: RingCentral SMS endpoint'i tashqi idempotency key'ni qo'llashi tasdiqlanmaguncha, "bulk hech qachon yo'qolmaydi" va "bitta SMS ikki marta ketmaydi" degan kafolatlarni birga va'da qilib bo'lmaydi.
