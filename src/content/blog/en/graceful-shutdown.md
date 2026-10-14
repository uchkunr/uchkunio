---
title: "Graceful shutdown: not losing a single request during a deploy"
date: "2026-10-06"
excerpt: "Every deploy shuts down the old processes. By default, Node.js treats SIGTERM as a signal to exit immediately, and requests still in progress are cut off. A proper shutdown saved all 20 requests."
tags:
  - nodejs
  - kubernetes
  - reliability
---

Before removing a pod, Kubernetes sends it SIGTERM, waits 30 seconds by default, and only then stops it forcibly with SIGKILL. If a Node.js process has no handler for SIGTERM, it exits the moment it receives the signal, and every request in progress at that moment is cut off.

In the test, each request takes 2 seconds, 20 requests are sent to the server, and SIGTERM arrives 0.5 seconds later.

```text
default   20 in-flight -> 20 x UND_ERR_SOCKET   /ready after SIGTERM: ECONNREFUSED
graceful  20 in-flight -> 20 x 200              /ready after SIGTERM: 503   exit: 0 after 2047 ms
```

![Twenty 2-second requests and a SIGTERM at 0.5 seconds: the default server drops all 20, the graceful server completes all 20](/sketches/shutdown/in-flight.svg)

## Four steps

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

In the first step, `/ready` starts returning 503, and the load balancer stops sending new requests to the pod. The second step is needed because the load balancer notices this change not immediately but at its next readiness check, and requests that arrive in the meantime must still be served. In the third step, `server.close()` stops accepting new connections and waits for the requests already started to finish. The fourth step is a safeguard: if some request hangs, the process exits on its own before Kubernetes sends SIGKILL.

![SIGTERM turns readiness off, after 1 second the server stops accepting new connections, and it exits at 2 seconds once the started requests finish](/sketches/shutdown/timeline.svg)

## The keep-alive trap

In the first version, the server shut down after 5 seconds rather than 2. After the response was sent, keep-alive connections stayed open and idle until `keepAliveTimeout` expired, which is 5 seconds in Node.js, and `server.close()` waited for them to close. If `Connection: close` is added to the response during shutdown, the connection is closed right after the response:

```js
if (!ready) res.setHeader("Connection", "close");
```

## Not just HTTP

The same order applies to every resource: first stop taking new work, then finish the work already started, and close connections last. Queue consumers stop taking new messages and finish the ones they hold, cron jobs do not start their next run, and the database pool is the very last thing to close. The worker in [pgmq-ts](/en/blog/postgres-queue-in-your-transaction) behaves exactly this way when an `AbortSignal` arrives.
