---
title: "RingCentral orqali SMS: bulk navbatda, direct xabar darhol, limit 40 so'rov/daqiqa"
date: "2026-10-14"
excerpt: "Bitta foydalanuvchi 5000 ta SMS yuborganda boshqalarning direct xabari va lead'ga birinchi xabar navbatda qolib ketmasligi kerak. Carlink'da buni Postgres'dagi holat mashinasi, har foydalanuvchiga alohida Hangfire job va Redis'dagi ikkita kalit hal qiladi."
tags:
  - architecture
  - reliability
  - redis
---

RingCentral har bir foydalanuvchi uchun daqiqasiga 40 ta so'rovga ruxsat beradi (Medium guruh). Carlink'da (avtomobil tashish CRM'i) har dispatcher o'z RingCentral akkaunti orqali SMS yuboradi va uch xil yuborish bor: bulk (bir bosishda minglab lead'ga), direct (chatdan bitta raqamga) va lead biriktirilganda avtomatik birinchi xabar. Talab oddiy: bulk qolgan ikkitasini hech qachon to'sib qo'ymasin, 429 dan keyin birorta xabar yo'qolmasin va birortasi ikki marta ketmasin.

## Uch yo'l, bitta jadval

Priority bu tizimda navbatning xususiyati emas. Navbatga faqat bulk kiradi, qolgan ikki yo'l RingCentral'ga to'g'ridan-to'g'ri boradi:

- **Bulk.** `SendSMS` endpoint'i raqamlar soniga qaraydi: bittadan ko'p bo'lsa, har lead uchun `Messages` jadvaliga `Queued` holatida qator yozadi va `202 Accepted` qaytaradi. Yuborish keyin, fon jarayonida.
- **Direct.** Bitta raqam bo'lsa, qator `Pending` holatida yoziladi, `Sending` ga o'tkaziladi va RingCentral shu so'rov ichida chaqiriladi. Javob kelsa `Sent`, 429 kelsa qator `Queued` ga tushadi va navbat worker'i uni keyin yuboradi, boshqa xato bo'lsa `Failed`.
- **Lead'ga birinchi xabar.** Lead foydalanuvchiga biriktirilganda Hangfire job xuddi shu direct yo'ldan yuboradi. 429 bo'lsa, shu foydalanuvchining navbat worker'i `Retry-After` yoki 65 soniyadan keyin (qaysi biri katta bo'lsa) rejalashtiriladi.

![Bulk xabarlar Postgres navbatiga tushadi va har foydalanuvchining o'z Hangfire job'i orqali 1.6 soniya oraliq bilan yuboriladi; direct va lead'ga birinchi xabar navbatni chetlab RingCentral'ga to'g'ri boradi, faqat 429 bo'lsa navbatga qaytadi](/sketches/sms/paths.svg)

Shu sababli 30 ta foydalanuvchining bulk kampaniyasi direct xabarni kechiktira olmaydi: ular umuman bir navbatda emas. Bulk faqat `sms` worker'larini band qiladi, direct esa HTTP so'rovning o'zida ketadi.

## Navbat: Postgres'dagi holat mashinasi

Alohida navbat saqlagich yo'q. Xabar allaqachon `Messages` jadvalida, `SmsStatus` ustuni esa uning navbatdagi o'rni:

```text
Queued  -> Pending  -> Sending -> Sent
                               -> Failed      (non-retryable xato)
                               -> Queued      (429, token muddati, transient xato)
```

`Queued` xabar worker'ni kutadi, `Pending` worker olgan, `Sending` esa RingCentral chaqiruvi boshlangan, lekin javob hali kelmagan. Oxirgi holat ataylab RingCentral'dan oldin yoziladi: jarayon shu paytda o'lsa, xabarni "ehtimol ketgan" deb ajratib bo'ladi.

## Har foydalanuvchiga bitta worker

Dispatcher (`ProcessPendingSmsAsync`) har 5 daqiqada cron orqali va har bulk yuborishdan keyin ishlaydi. U `Queued` qatorlari bor foydalanuvchilarni topadi va har biri uchun bitta job yaratadi. Job'ning o'zi (`ProcessUserSmsAsync`) shu foydalanuvchining eng eski 200 ta `Queued` xabarini oladi, hammasini `Pending` qiladi, `From` raqami bo'yicha guruhlab, birma-bir yuboradi va 200 tadan ko'p qolgan bo'lsa o'zini qayta navbatga qo'yadi. Bu job'lar Hangfire'ning alohida `sms` navbatida 5 ta worker bilan ishlaydi: bir vaqtning o'zida ko'pi bilan 5 ta foydalanuvchi yuboradi, qolganlari 200 talik bo'laklar orasida navbat kutadi.

Redis bu yerda ikki narsani kafolatlaydi, ikkalasi ham bitta `SET NX EX`:

```text
sms:dispatch:{userId}      SET NX EX 600   bir foydalanuvchiga bir vaqtda bitta dispatch job
sms:user:{userId}:lock     SET NX EX 900   bir foydalanuvchiga bir vaqtda bitta sender
ringcentral:token:{userId} cache           token, muddati tugashiga 20 daqiqa qolganda yangilanadi
```

Dispatch kaliti bo'lmasa, cron va bulk endpoint bir foydalanuvchi uchun ikkita job yaratib qo'yardi. Lock esa ikki job bir foydalanuvchining 40 so'rov/daqiqa limitini baham ko'rishiga yo'l qo'ymaydi; u Lua skript bilan "faqat o'z qiymatim bo'lsa o'chir" tarzida bo'shatiladi, shunda muddati o'tgan lock'ni boshqa job o'chirib yubormaydi. Lock olinmasa job jim chiqib ketadi: xabarlar `Queued` da turibdi, keyingi dispatch ularni oladi.

## 40 so'rov/daqiqa

Worker ikki xabar orasida 1600 ms kutadi, bu daqiqasiga 37.5 ta so'rov. Qolgan zaxira RingCentral'ning javob header'laridan o'qiladi: `X-Rate-Limit-Remaining` 2 ga tushsa, worker `X-Rate-Limit-Window` plus 2 soniya uxlaydi va shundan keyin davom etadi. 429 kelsa inline retry qilinmaydi, hech qachon: xato tasniflanadi va job o'zini keyinroqqa rejalashtiradi.

| Xato turi | Xabar | Keyingi urinish |
| --- | --- | --- |
| Non-retryable (noto'g'ri raqam, MSG-240, opt-out) | `Failed` | yo'q, keyingi guruh davom etadi |
| Rate limit (429, CMN-301) | `Queued` | 60 s dan keyin |
| Token muddati (401, OAU-213) | `Queued`, token cache tozalanadi | 10 s dan keyin |
| Boshqa (transient) | `Queued` | 30 s dan keyin |

Hangfire'ning o'z retry'si o'chirilgan (`Attempts = 0`). Avvalgi versiyada har xato alohida retry job yaratar va bir foydalanuvchining 429 lari daqiqasiga 450 ta job'ga aylanib ketgan edi. Hozir guruhda birinchi "to'xtatuvchi" xato chiqqan zahoti qolgan xabarlar `Queued` ga qaytariladi va butun job bitta rejalashtirilgan urinish bilan tugaydi.

![1.6 soniya oraliq bilan daqiqasiga 37.5 ta SMS ketadi; qolgan zaxira 2 ga tushganda worker oynaning tugashini kutib, keyin davom etadi](/sketches/sms/pacing.svg)

## Yo'qolmaydi va ikki marta ketmaydi

Har holatning muddati bor. Dispatcher har safar `Sending` da 5 daqiqadan ko'p qolgan qatorlarni va `Pending` da 15 daqiqadan ko'p qolganlarini `Queued` ga qaytaradi: worker o'lgan, deploy bo'lgan yoki lock muddati tugagan bo'lsa ham xabar navbatga qaytadi. 10 daqiqadan ko'p `Queued` turgan xabarlar soni esa alohida metrika (`sms_queue_stuck_total`), u o'sa boshlasa worker'lar yetmayapti.

Ikki marta ketmasligini `Messages.IdempotencyKey` ustunidagi unique index kafolatlaydi, kalit yo'l bo'yicha farqlanadi:

```text
bulk:{batchId}:{leadId}:{callerId}      bitta kampaniyada bitta lead'ga bitta xabar
manual:{callerId}:{X-Client-Request-Id} chatdan qayta yuborilgan so'rov
first_msg:{leadId}:{callerId}           lead'ga birinchi xabar bir marta
```

Bulk'da `allowDuplicates=false` bo'lsa kalitga `batchId` o'rniga matn hash'i kiradi: aynan shu matn shu lead'ga ikkinchi marta yuborilmaydi. `Failed` qatorning kaliti tozalanadi, shuning uchun uni qayta yuborish mumkin. Bu [idempotency key](/blog/idempotency-keys) postidagi naqshning o'zi, faqat API javobi emas, xabar qatori saqlanadi.

## Chegaralar

Halol bo'lish kerak: direct va navbat bir-biridan bexabar. Bulk ketayotgan paytda yuborilgan direct xabar shu foydalanuvchining 40 so'rov/daqiqa zaxirasidan oladi, 429 ga uchrasa `Queued` ga tushadi va navbat FIFO bo'lgani uchun eski bulk qatorlari orqasida kutadi. `Sent` ham "RingCentral qabul qildi" degani, yetkazilgani emas: delivery webhook ulanmagan. Navbat so'rovi (`CreatedBy`, `SmsStatus`) bo'yicha indekssiz ishlaydi, jadval o'sgach bu birinchi bo'lib sezilib qoladi.

## Qanday test qilinadi

Loyihadagi testlar xUnit'da va RingCentral mijozi doim 429 qaytaradigan qilib almashtirilgan: shunda har xabar `Queued` da tugashi kerak va tizimning navbatga oid butun mantig'i tarmoqsiz tekshiriladi. Tekshiriladigan narsalar: 1000 va 5000 ta parallel yuborishda qatorlar soni aynan shuncha; 50 foydalanuvchi x 30 lead'da 1500 qator va takrorlanuvchi raqam yo'q; bir kampaniya ikki marta yuborilsa ikkinchisi `skipped`; `Sending` 5 daqiqadan keyin `Queued` ga qaytadi; `Sending` holati RingCentral chaqiruvidan oldin yoziladi.

Xuddi shu g'oyalar NestJS va Jest'da shunday ko'rinadi. RingCentral o'rniga 429 tashlaydigan fake, repozitoriy o'rniga xotiradagi `Map`:

```ts
class RateLimitedRingCentral implements RingCentralClient {
  calls = 0;
  async sendSms(): Promise<never> {
    this.calls++;
    throw new RingCentralError(429, "Too Many Requests", { retryAfter: 60 });
  }
}

it("5000 parallel yuborish: hammasi Queued, birortasi yo'qolmaydi", async () => {
  const batches = users.map((u) => service.enqueueBulk(u.id, leadsOf(u), "Hi {{name}}", { allowDuplicates: true }));
  await Promise.all(batches);
  const rows = [...repo.values()];
  expect(rows).toHaveLength(5000);
  expect(rows.every((m) => m.status === "Queued")).toBe(true);
  expect(new Set(rows.map((m) => m.idempotencyKey)).size).toBe(5000);
});
```

Ikkinchi test holatlar tartibini tekshiradi. Fake mijoz chaqirilgan paytda xabar qaysi holatda ekanini yozib oladi:

```ts
it("Sending holati RingCentral chaqiruvidan oldin yoziladi", async () => {
  const seen: string[] = [];
  rc.sendSms = async ({ messageId }) => {
    seen.push(repo.get(messageId)!.status);
    return { id: "rc-1" };
  };
  await worker.processUser(user.id); // 1 ta Queued xabar bilan
  expect(seen).toEqual(["Sending"]);
  expect(repo.get(message.id)!.status).toBe("Sent");
});
```

Uchinchisi dispatch kalitini tekshiradi: `ioredis-mock` bilan `SET NX` ikki marta chaqirilsa, ikkinchi dispatcher job yaratmasligi kerak. Shu uchta test navbatning asosiy uchta va'dasini qoplaydi: yo'qolmaydi, ikki marta ketmaydi, bir foydalanuvchiga bir vaqtda bitta sender.

## Qoidalar

1. Priority'ni navbat ichida emas, navbatdan tashqarida hal qiling: shoshilinch xabar navbatga umuman kirmasin.
2. Limitni taxmin qilmang, provayderning header'idan o'qing va 429 ni inline retry qilmang.
3. Retry'ni framework'ga bermang: xatoni tasniflang va har job o'zini bir marta rejalashtirsin, aks holda job'lar ko'payib ketadi.
4. Navbatdagi har bir holatga muddat qo'ying va muddati o'tganlarni qaytaruvchi cron yozing. Worker o'lishi normal holat.
