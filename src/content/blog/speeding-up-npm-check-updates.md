---
title: "npm paketlarini tekshirishni 3 barobar tezlashtirish"
date: "2026-07-01"
excerpt: "npm-check-updates har bir paket uchun uning butun tarixini yuklab oladi. Buni kichik so'rov bilan almashtirish oson, biroq o'lchovlar asosiy muammo boshqa joyda ekanini ko'rsatdi."
tags:
  - nodejs
  - typescript
  - open-source
  - performance
---

`npm-check-updates` loyihadagi paketlarning yangi versiyalarini topib beradi. Men undan deyarli har kuni foydalanaman va o'rtacha loyihada natijani uch soniyacha kutishga to'g'ri keladi. Sababini bilish uchun avvalo u registry'ga qanday so'rov yuborishini ko'rib chiqdim.

## Registry nima qaytaradi

Paket haqidagi ma'lumotni npm registry'dan ikki xil olish mumkin:

```bash
$ curl -s https://registry.npmjs.org/typescript | wc -c
15788071
$ curl -s https://registry.npmjs.org/typescript/latest | wc -c
4833
```

Birinchi manzil paketning butun tarixini qaytaradi: har bir versiya, uning bog'liqliklari va chiqqan sanasi. `typescript` uchun bu 15 megabayt JSON demakdir. Ikkinchi manzil esa faqat oxirgi versiyani beradi.

![GET /typescript 15.8 MB qaytaradi, GET /typescript/latest esa atigi 4.8 KB](/sketches/npm/payload.svg)

`ncu` birinchi manzildan foydalanadi va buning asosli sababi bor: `--target minor` kabi rejimlar versiyalar tarixisiz ishlamaydi. Bu imkoniyatlarni saqlagan holda so'rov qatlamini qayta yozish katta va xavfli o'zgarish bo'lardi. Menga esa ularning birortasi kerak emas edi, shu bois alohida kichik vosita yozishga qaror qildim.

## fast-ncu

Asosiy ish bitta funksiyada bajariladi:

```ts
async function fetchLatestVersion(name: string): Promise<string | null> {
  const encodedName = name.startsWith("@")
    ? `@${encodeURIComponent(name.substring(1))}`
    : encodeURIComponent(name);

  const response = await fetch(`https://registry.npmjs.org/${encodedName}/latest`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry responded with status ${response.status}`);

  const data = (await response.json()) as { version?: string };
  return data.version ?? null;
}
```

Scoped paketlarda `/` belgisi kodlanadi, aks holda registry so'rovni tushunmaydi: `@types/node` uchun manzil `@types%2Fnode/latest` bo'ladi. Olingan versiyalar besh daqiqaga vaqtinchalik faylga yoziladi, shuning uchun tekshiruvdan so'ng `-u` bilan yangilaganda tarmoqqa qayta murojaat qilinmaydi:

```ts
const CACHE_FILE = path.join(os.tmpdir(), "fast-ncu-cache.json");
const DEFAULT_CACHE_TTL = 5 * 60 * 1000;
```

## O'lchov nimani ko'rsatdi

Sinov 78 ta bog'liqligi bo'lgan loyihada, ya'ni `ncu` repo'sining o'zida o'tkazildi:

| Vosita | Parallel so'rovlar | Vaqt |
| --- | --- | --- |
| `ncu` | standart | 2.75 s |
| `fast-ncu` | 15 | 2.70 s |
| `fast-ncu` | 30 | 0.88 s |

![78 ta bog'liqlikni tekshirish: ncu 2.75 s, fast-ncu 15 ta so'rov bilan 2.70 s, 30 ta bilan 0.88 s](/sketches/npm/race.svg)

Javob hajmi uch ming barobar kichraygan bo'lsa ham, ikkinchi qatorda vaqt deyarli o'zgarmagan. Demak, vaqt ma'lumotni yuklab olishga emas, har bir javobni kutishga sarflanadi:

```bash
$ curl -s -o /dev/null -w '%{time_total}\n' https://registry.npmjs.org/react/latest
0.304698
```

Besh kilobaytlik javob uchun ham borib kelish 0.3 soniya oladi. Bunday sharoitda samarali yo'l bitta: bir vaqtda ko'proq so'rov yuborish. Parallel so'rovlar sonini 30 ga oshirish vaqtni uch barobar qisqartirdi. Keshdan qilingan takroriy tekshiruv 10 millisekundda tugaydi, biroq uni `ncu` bilan solishtirib bo'lmaydi, chunki bu holatda tarmoqqa umuman murojaat qilinmaydi.

```bash
npx fast-ncu
npx fast-ncu -u --concurrency 30
```

`fast-ncu` faqat `latest` tegini tekshiradi. Monorepo, lockfile yoki `--target minor` kerak bo'lsa, `ncu` ning o'zi to'g'ri tanlov bo'lib qoladi.
