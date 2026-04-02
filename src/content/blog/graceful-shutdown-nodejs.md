---
title: "Graceful Shutdown in Node.js: Stop Killing Your Users' Requests"
date: "2025-11-20"
excerpt: "Your Node.js server gets SIGTERM, immediately dies, and 47 users get 502 errors. Here's how to shut down properly in production."
tags:
  - nodejs
  - devops
  - backend
---

# Graceful Shutdown in Node.js: Stop Killing Your Users' Requests

I once deployed a hotfix to production and watched our error rate spike to 12% for thirty seconds. The fix itself was fine. The problem was the deployment. Every time a container was replaced, in-flight requests got terminated. Users got 502s. WebSocket connections dropped. A background job processing a payment was killed mid-transaction.

All of this was preventable.

## What Happens When Your Process Dies

When Kubernetes (or Docker, or systemd) wants to stop your process, it sends `SIGTERM`. If your process does not exit within a grace period (default 30 seconds in Kubernetes), it sends `SIGKILL`. You cannot catch or handle `SIGKILL`.

If you have no signal handling, Node.js exits immediately on `SIGTERM`. Every in-flight HTTP request gets a TCP reset. Every database transaction is left in an undefined state. Every WebSocket client gets disconnected without a close frame.

## The Minimum Viable Graceful Shutdown

At bare minimum, you need to stop accepting new connections and wait for existing ones to finish:

```javascript
const http = require('http');
const app = require('./app'); // Your Express/Fastify/Koa app

const server = http.createServer(app);

server.listen(3000, () => {
  console.log('Server listening on port 3000');
});

function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close((err) => {
    if (err) {
      console.error('Error during server close:', err);
      process.exit(1);
    }
    console.log('All connections closed. Exiting.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

There is a problem. `server.close()` waits for all keep-alive connections to finish. A client with a keep-alive connection that sends no new requests will hold your server open indefinitely. You need a hard deadline:

```javascript
function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Starting graceful shutdown...`);

  // Hard deadline: force exit after 25 seconds
  // (Kubernetes default grace period is 30s, leave some buffer)
  const forceExitTimeout = setTimeout(() => {
    console.error('Forced shutdown - timeout exceeded');
    process.exit(1);
  }, 25_000);

  // Don't let this timer keep the process alive
  forceExitTimeout.unref();

  server.close(() => {
    console.log('Server closed cleanly');
    process.exit(0);
  });
}
```

## Draining Connections Properly

The `server.close()` call stops accepting new connections on the listening socket, but existing keep-alive connections stay open. You need to track and close idle connections:

```javascript
const connections = new Set();

server.on('connection', (socket) => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
});

function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Shutting down...`);

  const forceExitTimeout = setTimeout(() => {
    console.error('Forcing exit');
    process.exit(1);
  }, 25_000);
  forceExitTimeout.unref();

  server.close(() => {
    process.exit(0);
  });

  // Close idle keep-alive connections
  for (const socket of connections) {
    // If the socket has no pending requests, destroy it
    if (!socket._httpMessage) {
      socket.destroy();
    } else {
      // For sockets with in-flight requests, tell the client
      // not to reuse this connection
      socket._httpMessage.setHeader('Connection', 'close');
    }
  }
}
```

Setting the `Connection: close` header tells the client to not send another request on this keep-alive connection. Once the current response finishes, the socket closes, and `server.close()` can complete.

## Health Checks During Shutdown

If you are behind a load balancer, you need to start failing health checks before you stop accepting requests. Otherwise, the load balancer keeps sending traffic to a server that is shutting down.

```javascript
let isShuttingDown = false;

// Health check endpoint
app.get('/health', (req, res) => {
  if (isShuttingDown) {
    res.status(503).json({ status: 'shutting_down' });
  } else {
    res.status(200).json({ status: 'healthy' });
  }
});

function gracefulShutdown(signal) {
  console.log(`Received ${signal}`);

  // Step 1: Start failing health checks
  isShuttingDown = true;

  // Step 2: Wait for load balancer to stop sending traffic
  // Most LBs check every 5-10 seconds, so wait a bit
  setTimeout(() => {
    // Step 3: Now close the server
    server.close(() => {
      process.exit(0);
    });

    // Close idle connections
    for (const socket of connections) {
      if (!socket._httpMessage) socket.destroy();
    }
  }, 5_000);

  // Hard deadline
  setTimeout(() => process.exit(1), 25_000).unref();
}
```

This two-phase approach is critical. Without the delay, you get a race condition: the server stops accepting connections at the same time as the load balancer stops sending them. During that window, the LB sends requests to a closed port and users get errors.

## Cleaning Up Resources

In a real application, you have database connections, Redis clients, background job processors, and other resources that need cleanup:

```javascript
async function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Starting shutdown sequence...`);
  isShuttingDown = true;

  const forceExit = setTimeout(() => process.exit(1), 25_000);
  forceExit.unref();

  try {
    // Phase 1: Stop accepting new work
    await new Promise((resolve) => server.close(resolve));
    console.log('HTTP server closed');

    // Phase 2: Finish in-flight work
    await jobQueue.drain(); // Wait for running jobs to complete
    console.log('Job queue drained');

    // Phase 3: Close external connections
    await Promise.allSettled([
      mongoose.connection.close(),
      redisClient.quit(),
      kafkaProducer.disconnect(),
    ]);
    console.log('External connections closed');

    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
}
```

Use `Promise.allSettled`, not `Promise.all`. If Redis is already down (which might be why you are restarting), you do not want a Redis disconnect error to prevent your database from closing cleanly.

## Kubernetes-Specific Configuration

Kubernetes sends `SIGTERM`, waits for `terminationGracePeriodSeconds` (default 30), then sends `SIGKILL`. You need your shutdown to complete within that window.

```yaml
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 45
      containers:
        - name: api
          lifecycle:
            preStop:
              exec:
                command: ["sh", "-c", "sleep 5"]
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            periodSeconds: 5
            failureThreshold: 1
```

The `preStop` hook runs before `SIGTERM` is sent. That 5-second sleep gives Kubernetes time to update its endpoint list and stop routing traffic to this pod. Without it, there is a race condition between the endpoint update propagating and your pod shutting down.

The timeline looks like this:

```
1. Kubernetes decides to terminate the pod
2. preStop hook runs (sleep 5)              ← LB stops sending traffic
3. SIGTERM is sent to the process
4. Your graceful shutdown begins
5. Health check returns 503                 ← Belt and suspenders
6. Connections drain, resources close
7. Process exits with code 0
```

## The Complete Implementation

Here is what I use in production, all in one place:

```javascript
const http = require('http');
const app = require('./app');

const server = http.createServer(app);
const connections = new Set();
let isShuttingDown = false;

server.on('connection', (socket) => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
});

app.get('/health', (req, res) => {
  if (isShuttingDown) return res.status(503).end();
  res.status(200).json({ status: 'ok' });
});

async function shutdown(signal) {
  if (isShuttingDown) return; // Prevent double shutdown
  isShuttingDown = true;
  console.log(`[shutdown] ${signal} received`);

  const kill = setTimeout(() => {
    console.error('[shutdown] Forced exit after timeout');
    process.exit(1);
  }, 25_000);
  kill.unref();

  // Close idle connections, mark active ones for close
  for (const socket of connections) {
    if (!socket._httpMessage) {
      socket.destroy();
    } else {
      socket._httpMessage.setHeader('Connection', 'close');
    }
  }

  // Wait for server to close
  await new Promise((resolve) => server.close(resolve));
  console.log('[shutdown] HTTP server closed');

  // Cleanup application resources
  try {
    await app.locals.cleanup?.();
  } catch (err) {
    console.error('[shutdown] Cleanup error:', err.message);
  }

  console.log('[shutdown] Clean exit');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Catch unhandled errors during shutdown
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err);
  process.exit(1);
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Server listening on port ${server.address().port}`);
});
```

## Common Mistakes

**Not handling SIGINT.** Docker Compose sends SIGINT (Ctrl+C). If you only handle SIGTERM, local development restarts kill requests.

**Calling process.exit() immediately.** I have seen `process.on('SIGTERM', () => process.exit(0))` in production code. This is worse than no handler at all because it looks intentional.

**Forgetting about WebSockets.** `server.close()` does not close WebSocket connections. You need to send close frames to your WS clients separately.

**Not testing it.** Send SIGTERM to your process locally and verify that in-flight requests complete. `kill -15 <pid>` on Linux/Mac, or use `process.kill(process.pid, 'SIGTERM')` in a test.

The difference between a deployment that causes zero errors and one that causes hundreds is about 50 lines of code. Write them once, put them in a shared library, and never think about it again.
