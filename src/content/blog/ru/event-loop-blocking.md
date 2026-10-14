---
title: "Блокировка event loop в Node.js: один JSON.parse останавливает весь сервис"
date: "2026-10-12"
excerpt: "Разбор JSON размером 60 МБ занимает 286 мс, и всё это время сервер не отвечает ни на один другой запрос. Замер, что показывает p99, и решение с worker thread."
tags:
  - nodejs
  - performance
  - concurrency
---

Node.js выполняет весь JavaScript-код в одном потоке. Когда речь идёт об ожидании ввода-вывода, это преимущество: один поток обслуживает тысячи соединений. Но синхронное вычисление целиком занимает этот поток, и пока оно не закончится, не выполняется ничего другого, даже `/health`.

Эксперимент: endpoint импорта разбирает загруженный файл размером 60 МБ (400 000 заказов), а в это время `/health` опрашивается каждые 10 мс, не дожидаясь предыдущего ответа.

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

Медиана почти не изменилась, а p99 вырос более чем в 80 раз: 23 запроса, пришедшие за 286 мс разбора, ждали в очереди. Среднее значение эту проблему скрывает, а p99 показывает её отчётливо. В сервисе, который получает тысячу запросов в секунду, один импорт заставит ждать сотни пользователей.

![JSON.parse в основном потоке блокирует его на 286 мс, и 23 health check ждут в очереди; с worker основной поток продолжает отвечать](/sketches/event-loop/blocked.svg)

## Worker thread

Тяжёлая синхронная работа выносится в отдельный поток:

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

Импорт замедлился на 55 мс: запуск worker и возврат результата требуют времени. Это правильный размен: один импорт идёт чуть дольше, зато все остальные запросы не блокируются. Важно, чтобы файл читал сам worker. Если передать строку в 60 МБ через `workerData`, она копируется в основном потоке, и в замере возвращается блокировка на 47 мс. В продакшене не создают новый worker на каждый запрос, а используют готовый пул вроде Piscina.

![p99 для /health во время импорта 60 МБ: 259 мс с JSON.parse в основном потоке, 4.2 мс с worker](/sketches/event-loop/p99-race.svg)

## Как измерить блокировку

В самом Node.js есть инструмент, который измеряет задержку event loop:

```js
import { monitorEventLoopDelay } from "node:perf_hooks";

const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
setInterval(() => {
  console.log(`event loop p99: ${(delay.percentile(99) / 1e6).toFixed(1)} ms`);
  delay.reset();
}, 10_000);
```

Достаточно вывести этот показатель в метрики и настроить на него алерт. Типичные источники блокировки: большие `JSON.parse` и `JSON.stringify`, синхронная криптография вроде `crypto.pbkdf2Sync`, сложные регулярные выражения и вызовы `fs.*Sync` внутри обработки запроса.
