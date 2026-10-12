---
title: "Mikroservislardagi asosiy patternlar: har biri qaysi muammoni yechadi"
date: "2026-09-01"
excerpt: "Mikroservisda funksiya chaqiruvi tarmoqdan o'tadi: u kechikadi, yo'qoladi, ikki marta bajariladi. Sakkizta pattern, ularning har biri yechadigan muammo va ishlab turgan kod."
tags:
  - architecture
  - microservices
  - distributed-systems
  - typescript
---

Monolitda funksiya chaqiruvi yo natija qaytaradi, yo xato. Mikroservisda u tarmoqdan o'tadi va yangi holatlar paydo bo'ladi: javob kechikadi, yo'qoladi, amal ikki marta bajariladi yoki bajarilgani noma'lum qoladi. Quyidagi patternlarning har biri shu holatlardan biriga javob:

| Pattern | Qaysi muammoni yechadi |
| --- | --- |
| Database per Service | Servislar bir-birining jadvallariga bog'lanib qoladi |
| API Gateway | Mijoz o'nlab servis manzilini bilishga majbur |
| Saga | Bir nechta servisdagi amal uchun umumiy tranzaksiya yo'q |
| Outbox va idempotent iste'molchi | Xabar yo'qoladi yoki ikki marta keladi |
| Circuit Breaker | Ishlamayotgan servis uni chaqirayotganlarni ham qulatadi |
| Retry, backoff va jitter | Vaqtinchalik xatolar va bir vaqtda qayta urinishlar to'lqini |
| Distributed Tracing | So'rov o'nta servisdan o'tadi, xato qayerda ekani noma'lum |

![Mijoz, API gateway va har biri o'z bazasiga ega uchta servis, voqealar outbox orqali Kafka'ga ketadi](/sketches/microservices/map.svg)

## Database per Service

Har bir servis o'z ma'lumotining yagona egasi bo'ladi, boshqalar unga faqat API yoki voqea orqali murojaat qiladi. Umumiy jadvalda bitta ustunni o'zgartirish bir vaqtning o'zida bir necha servisni sindiradi va mustaqil deploy ma'nosini yo'qotadi. Bitta Postgres ichida ham buni huquqlar bilan majburlash mumkin: `CREATE SCHEMA orders AUTHORIZATION orders_svc;` dan keyin boshqa rollar bu schema'ga ruxsatsiz kira olmaydi.

## API Gateway

Mijoz bitta manzilga murojaat qiladi, gateway esa so'rovni kerakli servisga yo'naltiradi, autentifikatsiya va rate limiting'ni bir joyda bajaradi. Biznes mantiqi gateway'ga kirmasligi kerak, aks holda u asta-sekin yangi monolitga aylanadi.

## Saga

Buyurtma, to'lov va zaxira uch xil servisda bo'lsa, ularni bitta tranzaksiyaga o'rab bo'lmaydi. Saga har bir qadamga uni bekor qiluvchi kompensatsiyani biriktiradi va xato chiqqanda bajarilgan qadamlarni teskari tartibda qaytaradi:

```ts
type Step = { name: string; run: () => Promise<void>; undo: () => Promise<void> };

async function runSaga(steps: Step[]): Promise<void> {
  const done: Step[] = [];
  for (const step of steps) {
    try {
      await step.run();
      done.push(step);
    } catch (error) {
      console.log(`${step.name} failed: ${(error as Error).message}`);
      for (const completed of done.reverse()) await completed.undo();
      throw error;
    }
  }
}
```

```text
order created
payment charged
stock failed: out of stock
payment refunded
order cancelled
```

Bu orkestratsiya: qadamlarni bitta markaz boshqaradi. Muqobili xoreografiya, unda servislar bir-birining voqealariga o'zi javob beradi. Qadamlar ko'paygani sari orkestratsiyani kuzatish va tushunish osonroq bo'ladi.

## Outbox va idempotent iste'molchi

Bazaga yozish va brokerga xabar yuborish bitta tranzaksiyaga sig'maydi, shuning uchun xabar o'sha bazadagi outbox jadvaliga yoziladi, yetkazishni esa relay bajaradi. Relay xabarni kamida bir marta yetkazadi, demak iste'molchi takrorni o'zi aniqlashi kerak. Ikkalasi [alohida maqolada](/blog/transactional-outbox-pattern) haqiqiy natijalar bilan ko'rib chiqilgan.

## Circuit Breaker

To'lov servisi ishlamay qolsa, unga so'rov yuborishda davom etish ikki tomonga ham zarar: chaqiruvchi har safar timeout'ni kutadi, tiklanayotgan servis esa yangi yuk ostida qoladi. Circuit breaker ketma-ket xatolardan keyin "ochiladi" va so'rovlarni darhol rad etadi, belgilangan vaqtdan so'ng esa bitta sinov so'rovini o'tkazadi:

```ts
async call<T>(fn: () => Promise<T>): Promise<T> {
  if (this.state === "open") {
    if (Date.now() - this.openedAt < this.resetMs) throw new Error("circuit open");
    this.state = "half-open";
  }
  try {
    const result = await fn();
    this.state = "closed";
    this.failures = 0;
    return result;
  } catch (error) {
    this.failures++;
    if (this.state === "half-open" || this.failures >= this.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
    throw error;
  }
}
```

To'lov servisi birinchi 1.5 soniya ishlamaydi, chegara 3 xato, ochiq turish vaqti 1 soniya:

```text
   0 ms  closed -> payments 503   (closed)
 271 ms  closed -> payments 503   (closed)
 542 ms  closed -> payments 503   (open)
 812 ms  open   -> circuit open   (open)
1316 ms  open   -> circuit open   (open)
1566 ms  open   -> ok             (closed)
```

![Circuit breaker holatlari: 3 xatogacha yopiq, 1 soniya ochiq, keyin bitta sinov so'rovi hal qiladi](/sketches/microservices/breaker.svg)

Ochiq holatda so'rovlar tarmoqqa umuman chiqmaydi. 1566-millisekunddagi sinov so'rovi muvaffaqiyatli o'tadi va breaker yopiladi.

## Retry, backoff va jitter

Vaqtinchalik xatoni qayta urinish yechadi, lekin ikki shart bilan. Birinchisi, har bir tarmoq chaqiruvi timeout'ga ega bo'lishi kerak: `fetch(url, { signal: AbortSignal.timeout(2000) })`. Ikkinchisi, kutish vaqti har urinishda ikki baravar oshadi va tasodifiy tanlanadi:

```ts
const backoff = (attempt: number, baseMs = 100, capMs = 5000) =>
  Math.random() * Math.min(capMs, baseMs * 2 ** attempt);
```

Tasodifiylik nima uchun kerakligi servis qulab, keyin tiklanganda ko'rinadi: barcha mijozlar bir vaqtda xato oladi va bir vaqtda qayta urinadi. 1000 ta mijoz, to'rtinchi urinish:

```text
bir xil 100 ms oralig'iga tushgan so'rovlar:  jitter'siz 1000,  jitter bilan 74
```

![1000 ta mijoz qayta urinadi: jitter'siz hammasi bir vaqtda, jitter bilan 0 dan 1600 ms gacha yoyilgan](/sketches/microservices/jitter.svg)

Faqat idempotent amallar qayta uriniladi. To'lovni qayta yuborish uchun so'rov idempotency key bilan keladi va server uni bir marta bajaradi.

## Distributed Tracing

Bitta foydalanuvchi so'rovi gateway, buyurtma, to'lov va zaxira servislaridan o'tadi. Har bir servis W3C standartidagi `traceparent` header'ini keyingisiga uzatadi va loglar bitta `trace-id` atrofida birlashadi:

```text
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
               |  trace-id (butun so'rov)          span-id (shu qadam)
```

OpenTelemetry HTTP klientlari va serverlari uchun bu header'ni avtomatik uzatadi. Usiz o'n servisdagi xatoni topish o'n xil logni vaqt bo'yicha qo'lda moslashtirishga aylanadi.

Har bir pattern o'z narxiga ega: kod, infratuzilma va murakkablik. Uni muammo haqiqatda paydo bo'lganda qo'shing, oldindan emas.
