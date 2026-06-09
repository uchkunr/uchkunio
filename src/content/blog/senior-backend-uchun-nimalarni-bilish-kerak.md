---
title: "Senior backend developer bo'lish uchun men nima o'rganayapman"
date: "2026-06-09"
excerpt: "Framework ishlatish bilan haqiqiy backend tushunish orasida katta farq bor. Shu farqni yo'q qilish uchun men hozir nimalarga fokus qilayapman."
tags:
  - career
  - typescript
  - backend
---

# Senior backend developer bo'lish uchun men nima o'rganayapman

Bir kuni o'zimga savol berdim: men yaxshi ishlaydigan kod yozaman, lekin tizim sekin bo'lib qolsa — asl sababni topamanmi? Redis qachon zarar qilishini bilaman? Event loop bloklanganda nima bo'layotganini ko'ramanmi?

Javob to'liq "ha" emas edi.

Shu paytdan boshlab o'rganish usulim o'zgardi. Kurs ko'rish emas, tushunmasdan qo'llash emas — asoslarni haqiqatda bilish. Quyida men hozir fokus qilayotgan sohalar va nega aynan shular.

---

## JavaScript runtime — "ishlaydi" emas, "nega ishlaydi"

Eng ko'p vaqt ketayotgan joy shu.

Event loop haqida ko'p eshitganman, lekin bir kuni `setTimeout(fn, 0)` va `Promise.resolve().then(fn)` qaysi biri oldin ishlashini tushuntira olmadim. Shunda angladim — bilaman deb o'ylardim, aslida yod olgandim.

Hozir o'rganayotganlarim:

- **Call stack, heap, task queue** — nafaqat nima ekanligini, balki real holatlarda qanday muammo keltirib chiqarishini
- **Microtask vs macrotask** — `Promise`, `queueMicrotask`, `setTimeout`, `setImmediate` tartibini
- **Closure va memory leak** — ko'p vaqt event listener tozalanmay qoladi, server ham RAM yeydi
- **`this` binding** — arrow function va oddiy function farqi, `call/apply/bind` aslida nima qiladi

TypeScript tomonidan esa generics-ni yaxshilab o'rganayapman. `<T extends ...>`, `infer`, conditional types — bular faqat type yozish emas, murakkab library API-larni o'qish uchun ham kerak.

---

## DSA — leetcode emas, pattern

Algoritm o'rganishga uzoq vaqt qarshi bo'ldim. "Real ishda ishlatmayman" deb. Lekin interview boshqa narsa — u fikrlash tezligini tekshiradi, xotirani emas.

Endi kun sayin bitta masala yechaman. Muhimi — qanday yechdim emas, **qaysi pattern ekanligini** tushundim.

Hozircha fokus:

- Sliding window
- Two pointers
- HashMap bilan frequency counting
- BFS/DFS — graph emas, tree bo'ylab fikrlash odati sifatida

300 ta masala yechish maqsad emas. 150 ta masalani pattern bilan tushunib yechish — maqsad.

---

## PostgreSQL — "query ishlayapti" emas, "nega sekin"

Backend muammolarining katta qismi aslida database muammosi. Slow query, yomon index, N+1 — bularni ko'rmasdan kod yozib yuraverdim.

Hozir o'rganayotganlarim:

- `EXPLAIN ANALYZE` — queryni bajarishdan oldin nima rejasi borligini o'qish
- Composite index qachon ishlaydi, qachon ishlatilmaydi
- Transaction isolation levels — `READ COMMITTED`, `REPEATABLE READ` farqi
- Deadlock qanday yuzaga keladi va qanday oldini olish mumkin
- Pagination — `OFFSET` katta tableda nima muammo keltirib chiqaradi

Har kuni bir masalani `EXPLAIN` bilan tekshirib ko'raman. Ko'pincha o'ylagan indexim index emas, sequential scan ekan.

---

## Redis — faqat cache emas

Redis-dan foydalanayotgandim, lekin ko'p vaqt uni shunchaki `key-value store` sifatida. Aslida nima qila olishini yaqinda chuqurroq o'rgandim.

Distributed lock, Lua script bilan atomic operatsiya, rate limiting — bularni real projectda yozgandim. Lekin hozir "qachon Redis zarar qiladi" degan savolga ham javob berish kerakligini bilaman:

- Cache invalidation strategy noto'g'ri bo'lsa, eskirgan ma'lumot muammosi
- TTL juda qisqa bo'lsa, cache hit rate past, DB ustida pressure
- Eviction policy `allkeys-lru` emas `noeviction` bo'lsa, memory to'lgan vaqtda xato

Bu savollar interview uchun emas — production-da duch kelamiz.

---

## Ingliz tili — texnik bilimdan ko'proq muhim bo'lishi mumkin

Bu biroz og'ir gap, lekin rostini aytaman.

Yaxshi developer bo'lganlar bor, lekin stackoverflow-dagi javobni o'qib anglamaydi. RFC-ni o'qolmaydi. Pull request ochib anglasharsiz muloqot qila olmaydi.

Men hozir:

- **Texnik ingliz** — PR description, commit message, documentation yozish
- **O'qish** — Martin Fowler, AWS blog, engineering blog postlar
- **Gapirishga harakat qilish** — o'zimga kod tushuntirish, ovozli

Bu skill boshqalaridan sekin o'sadi. Lekin bir kuni seniorlarga qo'shilganda — texnik bilim + ingliz tilida aniq muloqot qila olish — bu katta farq.

---

## Aslida nima o'zgartiryapman

Oldin: ko'proq framework o'rgan, ko'proq library ishlatishni bil.

Hozir: runtime tushun, database tushun, tizim qanday ishlaydigan tushun.

Framework o'zgaradi. Runtime o'zgarmaydi.

Shu ro'yxatdagi har bir narsa — 1-2 haftada o'rganib bo'linadigan mavzu emas. Ba'zilari oylar. Lekin har kuni biroz — event loop haqida o'qish, bitta masala yechish, bir queryga `EXPLAIN` qo'yish — vaqt o'tib juda katta farq qiladi.

Hozircha shu yo'lda.
