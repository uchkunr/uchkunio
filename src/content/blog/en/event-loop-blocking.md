---
title: "Event loop blocking in Node.js: one JSON.parse stops the whole service"
date: "2026-10-12"
excerpt: "Parsing a 60 MB JSON file takes 286 ms, and during that time the server does not respond to any other request. This post covers the measurement, what p99 reveals, and the fix with a worker thread."
tags:
  - nodejs
  - performance
  - concurrency
---

Node.js runs all JavaScript code on a single thread. When the work is waiting on I/O, this is an advantage: one thread serves thousands of connections. Synchronous computation, however, takes over that thread completely, and until it finishes nothing else runs, not even `/health`.

In the test, an import endpoint parses an uploaded 60 MB file (400 000 orders), while `/health` is requested every 10 ms without waiting for the previous response.

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

The median barely changed, while p99 rose more than 80-fold: the 23 requests that arrived during the 286 ms of parsing sat waiting in the queue. The average hides this problem, and p99 shows it plainly. In a service that receives a thousand requests per second, a single import keeps hundreds of users waiting.

![JSON.parse on the main thread blocks it for 286 ms while 23 health checks wait in the queue; with a worker, the main thread keeps responding](/sketches/event-loop/blocked.svg)

## Worker thread

Heavy synchronous work is moved to a separate thread:

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

The import became 55 ms slower, because starting the worker and returning the result take time. That is the right trade-off: one import is slightly slower, and none of the other requests are blocked. It matters that the worker reads the file itself. If we pass the 60 MB string through `workerData`, it is copied on the main thread, and the measurement shows a 47 ms block again. In production you do not start a new worker for each request; you use a ready-made pool such as Piscina.

![/health p99 during a 60 MB import: 259 ms with JSON.parse on the main thread, 4.2 ms with a worker](/sketches/event-loop/p99-race.svg)

## Measuring blocking

Node.js has a built-in tool for measuring event loop delay:

```js
import { monitorEventLoopDelay } from "node:perf_hooks";

const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
setInterval(() => {
  console.log(`event loop p99: ${(delay.percentile(99) / 1e6).toFixed(1)} ms`);
  delay.reset();
}, 10_000);
```

It is enough to export this value as a metric and put an alert on it. The usual blockers are large `JSON.parse` and `JSON.stringify` calls, synchronous cryptography such as `crypto.pbkdf2Sync`, complex regular expressions, and `fs.*Sync` calls inside a request.
