---
title: "Graceful shutdown: deploy paytida birorta so'rovni yo'qotmaslik"
date: "2026-10-06"
excerpt: "Har bir deploy eski jarayonlarni o'chiradi. Node.js SIGTERM'ni standart holatda darhol tugash deb tushunadi va yarim yo'ldagi so'rovlar uziladi. To'g'ri yopilish 20 ta so'rovning hammasini saqlab qoldi."
tags:
  - nodejs
  - kubernetes
  - reliability
---

Kubernetes pod'ni o'chirishdan oldin unga SIGTERM yuboradi, standart holatda 30 soniya kutadi va shundan keyingina SIGKILL bilan majburan to'xtatadi. Node.js'da SIGTERM uchun handler bo'lmasa, jarayon signalni olgan zahoti tugaydi va shu paytda bajarilayotgan barcha so'rovlar uziladi.

Sinov: har bir so'rov 2 soniya ishlaydi, serverga 20 ta so'rov yuboriladi va 0.5 soniyadan keyin SIGTERM keladi.

```text
default   20 in-flight -> 20 x UND_ERR_SOCKET   /ready after SIGTERM: ECONNREFUSED
graceful  20 in-flight -> 20 x 200              /ready after SIGTERM: 503   exit: 0 after 2047 ms
```

![2 soniyalik 20 ta so'rov va 0.5 soniyadagi SIGTERM: standart server 20 tasini uzadi, graceful server 20 tasini yakunlaydi](/sketches/shutdown/in-flight.svg)

## To'rt qadam

```js
process.on("SIGTERM", () => {
  ready = false; // 1. readiness fails, the load balancer stops sending traffic
  setTimeout(() => {
    server.close(() => process.exit(0)); // 3. stop accepting, exit when in-flight requests finish
    server.closeIdleConnections();
  }, 1000); // 2. give the load balancer time to notice
  setTimeout(() => process.exit(1), 30_000).unref(); // 4. hard deadline
});
```

Birinchi qadamda `/ready` 503 qaytara boshlaydi va load balancer pod'ga yangi so'rov yuborishni to'xtatadi. Ikkinchi qadam shuning uchun kerak: load balancer bu o'zgarishni darhol emas, keyingi readiness tekshiruvida sezadi va shu orada kelgan so'rovlarga ham xizmat ko'rsatilishi kerak. Uchinchi qadamda `server.close()` yangi ulanishlarni qabul qilishni to'xtatadi va boshlangan so'rovlar tugashini kutadi. To'rtinchisi esa kafolat: biror so'rov osilib qolsa, jarayon Kubernetes'ning SIGKILL'iga qadar o'zi chiqadi.

![SIGTERM readiness'ni o'chiradi, server 1 soniyadan keyin yangi ulanishlarni qabul qilmaydi, boshlangan so'rovlarni tugatib, 2 soniyada chiqadi](/sketches/shutdown/timeline.svg)

## Keep-alive tuzog'i

Birinchi versiyada server 2 soniyada emas, 5 soniyada o'chdi. Javob yuborilgandan keyin keep-alive ulanishlar bo'sh holatda `keepAliveTimeout` tugaguncha ochiq turdi, Node.js'da bu 5 soniya, `server.close()` esa ularning yopilishini kutdi. Yopilish paytida javobga `Connection: close` qo'shilsa, ulanish javobdan so'ng darhol yopiladi:

```js
if (!ready) res.setHeader("Connection", "close");
```

## Faqat HTTP emas

Xuddi shu tartib har bir resursga taalluqli: avval yangi ish olish to'xtatiladi, keyin boshlangan ish tugatiladi, eng oxirida ulanishlar yopiladi. Navbat consumer'lari yangi xabar olmaydi va qo'lidagisini yakunlaydi, cron vazifalar keyingi ishni boshlamaydi, baza pool'i esa eng so'nggi bo'lib yopiladi. [pgmq-ts](/blog/postgres-queue-in-your-transaction)'dagi worker ham `AbortSignal` kelganda aynan shunday ishlaydi.
