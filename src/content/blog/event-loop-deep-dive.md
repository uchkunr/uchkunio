---
title: "The Node.js Event Loop: Beyond the Basics"
date: "2026-03-05"
excerpt: "Most explanations of the event loop are oversimplified. Here's what actually happens, phase by phase, and why it matters."
tags:
  - nodejs
  - internals
  - backend
---

# The Node.js Event Loop: Beyond the Basics

"The event loop checks the callback queue and pushes callbacks to the call stack." This common explanation is incomplete. The event loop has **six phases**, and understanding them explains behaviors that otherwise seem like bugs.

## The Six Phases

```
   ┌───────────────────────────┐
┌─>│           timers          ���  setTimeout, setInterval
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │     pending callbacks     │  I/O callbacks deferred to next loop
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │       idle, prepare       │  internal use only
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │           poll            │  retrieve new I/O events
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │           check           │  setImmediate
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │      close callbacks      │  socket.on('close', ...)
│  └───────────────────────────┘
```

## Timers Phase

`setTimeout` and `setInterval` callbacks execute here. But there's a catch:

```typescript
setTimeout(() => console.log("timer"), 0);
```

"0ms" doesn't mean "immediately." It means "as soon as the timers phase runs, if at least 0ms have passed." The actual minimum delay is **1ms** (clamped by libuv).

## Poll Phase: Where Node Spends Most Time

The poll phase does two things:

1. Calculates how long it should block waiting for I/O
2. Processes events in the poll queue

This is where file reads, network responses, and database callbacks land. If nothing else is scheduled, Node blocks here waiting for I/O.

## The Microtask Queue

**Between every phase**, Node processes all microtasks:

```typescript
Promise.resolve().then(() => console.log("microtask"));
process.nextTick(() => console.log("nextTick"));
setTimeout(() => console.log("timer"), 0);
setImmediate(() => console.log("immediate"));
```

Output:
```
nextTick
microtask
timer       (or immediate — order depends on context)
immediate   (or timer)
```

`process.nextTick` runs before Promises. Both run before any phase callback.

## Why This Matters: Real Bugs

### Bug 1: Starving the Event Loop

```typescript
// ❌ This blocks the event loop
app.get("/compute", (req, res) => {
  const result = fibonacci(45); // CPU-bound, blocks everything
  res.json({ result });
});
```

While `fibonacci(45)` runs, **no other requests can be handled**. No timers fire, no I/O completes.

Fix: offload to a worker thread:

```typescript
import { Worker } from "node:worker_threads";

app.get("/compute", async (req, res) => {
  const result = await runInWorker(() => fibonacci(45));
  res.json({ result });
});
```

### Bug 2: setTimeout vs setImmediate

```typescript
// Inside an I/O callback, setImmediate always runs first
const fs = require("fs");

fs.readFile(__filename, () => {
  setTimeout(() => console.log("timeout"), 0);
  setImmediate(() => console.log("immediate"));
});

// Always outputs:
// immediate
// timeout
```

Because after I/O, the event loop is in the **poll phase**. The next phase is **check** (setImmediate), not **timers** (setTimeout).

### Bug 3: nextTick Starvation

```typescript
// ❌ This prevents any I/O from processing
function loop() {
  process.nextTick(loop);
}
loop();
```

`nextTick` runs between phases — if you keep adding nextTick callbacks, the event loop never advances. Use `setImmediate` instead for recursive scheduling.

## Measuring Event Loop Lag

```typescript
let lastCheck = Date.now();

setInterval(() => {
  const now = Date.now();
  const lag = now - lastCheck - 1000; // Expected 1000ms interval
  if (lag > 50) {
    logger.warn(`Event loop lag: ${lag}ms`);
  }
  lastCheck = now;
}, 1000);
```

If the interval consistently fires late, something is blocking the loop.

## Practical Rules

1. **Never do CPU work on the main thread** — use worker threads
2. **Prefer `setImmediate` over `process.nextTick`** for recursive operations
3. **Monitor event loop lag** in production
4. **Batch database operations** — 1 query with 100 results beats 100 queries
5. **Stream large payloads** — don't buffer entire files in memory
