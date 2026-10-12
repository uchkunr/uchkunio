---
title: "Node.js'da event loop bloklanishi: bitta JSON.parse butun servisni to'xtatadi"
date: "2026-10-12"
excerpt: "60 MB'lik JSON'ni parse qilish 286 ms oladi va shu vaqt ichida server boshqa hech bir so'rovga javob bermaydi. O'lchov, p99 nimani ko'rsatishi va worker thread bilan yechim."
tags:
  - nodejs
  - performance
  - concurrency
---

Node.js barcha JavaScript kodini bitta oqimda bajaradi. Kiritish-chiqarishni kutishda bu ustunlik: bitta oqim minglab ulanishga xizmat qiladi. Lekin sinxron hisoblash shu oqimni to'liq egallab oladi va u tugaguncha boshqa hech narsa bajarilmaydi, hatto `/health` ham.

Sinov: import endpoint'i yuklangan 60 MB'lik faylni (400 000 buyurtma) parse qiladi, shu paytda `/health` har 10 ms'da, oldingi javobni kutmasdan so'raladi.

```js
http.createServer(async (req, res) => {
  if (req.url === "/health") return res.end("ok");
  const orders = JSON.parse(readFileSync(file, "utf8"));
  res.end(`${orders.length} orders`);
});
```

```text
/health x300: p50 3.1 ms, p99 259.2 ms, max 283.3 ms, over 50 ms: 23
import: 400000 orders in 286 ms
```

Median deyarli o'zgarmadi, p99 esa 80 barobardan ko'proq oshdi: parse davom etgan 286 ms ichida kelgan 23 ta so'rov navbatda kutib qoldi. O'rtacha qiymat bu muammoni yashiradi, p99 esa uni aniq ko'rsatadi. Soniyasiga ming so'rov oladigan servisda bitta import yuzlab foydalanuvchini kuttiradi.

![Asosiy oqimdagi JSON.parse uni 286 ms bloklaydi va 23 ta health check navbatda kutadi; worker'da esa asosiy oqim javob berishda davom etadi](/sketches/event-loop/blocked.svg)

## Worker thread

Og'ir sinxron ish alohida oqimga chiqariladi:

```js
const worker = `
  const { parentPort, workerData } = require("node:worker_threads");
  const { readFileSync } = require("node:fs");
  parentPort.postMessage(JSON.parse(readFileSync(workerData, "utf8")).length);
`;

const parseInWorker = (path) =>
  new Promise((resolve, reject) => {
    new Worker(worker, { eval: true, workerData: path }).once("message", resolve).once("error", reject);
  });
```

```text
/health x300: p50 2.9 ms, p99 4.2 ms, max 15.3 ms, over 50 ms: 0
import: 400000 orders in 341 ms
```

Import 55 ms sekinlashdi: worker'ni ishga tushirish va natijani qaytarish vaqt oladi. Bu to'g'ri almashuv: bitta import biroz sekinroq, qolgan barcha so'rovlar esa bloklanmaydi. Faylni worker'ning o'zi o'qishi muhim. 60 MB'lik satrni `workerData` orqali uzatsak, u asosiy oqimda nusxalanadi va o'lchovda 47 ms'lik bloklanish qaytib keladi. Production'da har bir so'rov uchun yangi worker ochilmaydi, Piscina kabi tayyor pool ishlatiladi.

![60 MB import paytida /health p99: asosiy oqimdagi JSON.parse bilan 259 ms, worker'da 4.2 ms](/sketches/event-loop/p99-race.svg)

## Bloklanishni o'lchash

Node.js'ning o'zida event loop kechikishini o'lchaydigan vosita bor:

```js
import { monitorEventLoopDelay } from "node:perf_hooks";

const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
setInterval(() => {
  console.log(`event loop p99: ${(delay.percentile(99) / 1e6).toFixed(1)} ms`);
  delay.reset();
}, 10_000);
```

Bu ko'rsatkichni metrikaga chiqarib, ogohlantirish qo'yish kifoya. Odatiy bloklovchilar: katta `JSON.parse` va `JSON.stringify`, `crypto.pbkdf2Sync` kabi sinxron kriptografiya, murakkab regex va so'rov ichidagi `fs.*Sync` chaqiruvlari.
