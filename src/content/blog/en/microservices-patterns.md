---
title: "Core microservice patterns and the problem each one solves"
date: "2026-10-12"
excerpt: "In microservices a function call goes over the network, where it can be delayed, lost or executed twice. This post covers eight patterns, the problem each one solves, and working code for them."
tags:
  - architecture
  - microservices
  - distributed-systems
  - typescript
---

In a monolith, a function call either returns a result or throws an error. In microservices the call goes over the network, and new outcomes appear: the response is delayed or lost, the operation runs twice, or nobody knows whether it ran at all. Each of the patterns below answers one of these outcomes:

| Pattern | The problem it solves |
| --- | --- |
| Database per Service | Services become coupled to each other's tables |
| API Gateway | The client has to know the addresses of dozens of services |
| Saga | There is no shared transaction for an operation that spans several services |
| Outbox and idempotent consumer | A message is lost or arrives twice |
| Circuit Breaker | A failing service brings down the services that call it |
| Retry, backoff and jitter | Transient errors and waves of simultaneous retries |
| Distributed Tracing | A request passes through ten services, and nobody knows where it failed |

![Client, API gateway and three services, each owning its database, publishing events to Kafka through an outbox](/sketches/microservices/map.svg)

## Database per Service

Each service is the sole owner of its data, and other services reach that data only through an API or events. Changing a single column in a shared table breaks several services at once and makes independent deployment meaningless. You can enforce this with privileges even inside a single Postgres instance: after `CREATE SCHEMA orders AUTHORIZATION orders_svc;`, other roles cannot access the schema without being granted permission.

## API Gateway

The client sends requests to a single address, and the gateway routes each one to the right service while handling authentication and rate limiting in one place. Business logic must stay out of the gateway, otherwise it gradually turns into a new monolith.

## Saga

When orders, payments and stock live in three different services, they cannot be wrapped in a single transaction. A saga attaches to every step a compensating action that undoes it, and when an error occurs, it reverts the completed steps in reverse order:

```ts
type Step = { name: string; run: () => Promise<void>; undo: () => Promise<void> };

async function runSaga(steps: Step[]): Promise<void> {
  const done: Step[] = [];
  for (const step of steps) {
    try {
      await step.run();
      done.push(step);
    } catch (error) {
      console.log(`${step.name} failed: ${(error as Error).message}`);
      for (const completed of done.reverse()) await completed.undo();
      throw error;
    }
  }
}
```

```text
order created
payment charged
stock failed: out of stock
payment refunded
order cancelled
```

This is orchestration, where a single coordinator drives the steps. The alternative is choreography, in which services react to each other's events on their own. As the number of steps grows, orchestration is easier to follow and reason about.

## Outbox and idempotent consumer

Writing to the database and sending a message to a broker cannot fit into one transaction, so the message is written to an outbox table in the same database, and a relay takes care of delivery. The relay delivers each message at least once, which means the consumer has to detect duplicates on its own. Both are covered with real results in [a separate post](/en/blog/transactional-outbox-pattern).

## Circuit Breaker

When the payment service goes down, continuing to send it requests hurts both sides: the caller waits for a timeout every time, and the recovering service is hit with fresh load. A circuit breaker "opens" after a run of consecutive failures and rejects requests immediately, and after a set period it lets a single trial request through:

```ts
async call<T>(fn: () => Promise<T>): Promise<T> {
  if (this.state === "open") {
    if (Date.now() - this.openedAt < this.resetMs) throw new Error("circuit open");
    this.state = "half-open";
  }
  try {
    const result = await fn();
    this.state = "closed";
    this.failures = 0;
    return result;
  } catch (error) {
    this.failures++;
    if (this.state === "half-open" || this.failures >= this.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
    throw error;
  }
}
```

In this run the payment service is down for the first 1.5 seconds, the threshold is 3 failures, and the breaker stays open for 1 second:

```text
   0 ms  closed -> payments 503   (closed)
 271 ms  closed -> payments 503   (closed)
 542 ms  closed -> payments 503   (open)
 812 ms  open   -> circuit open   (open)
1316 ms  open   -> circuit open   (open)
1566 ms  open   -> ok             (closed)
```

![Circuit breaker states: closed until 3 failures, open for 1 s, then one half-open probe decides](/sketches/microservices/breaker.svg)

While the breaker is open, requests never reach the network. The trial request at 1566 ms succeeds, and the breaker closes.

## Retry, backoff and jitter

Retrying fixes a transient error, but only under two conditions. First, every network call must have a timeout: `fetch(url, { signal: AbortSignal.timeout(2000) })`. Second, the wait time doubles with every attempt and is chosen at random:

```ts
const backoff = (attempt: number, baseMs = 100, capMs = 5000) =>
  Math.random() * Math.min(capMs, baseMs * 2 ** attempt);
```

The need for randomness becomes clear when a service goes down and then recovers: every client gets an error at the same moment and retries at the same moment. Here are 1000 clients on their fourth attempt:

```text
requests landing in the same 100 ms window:  without jitter 1000,  with jitter 74
```

![1000 clients retrying: without jitter all at once, with full jitter spread over 0 to 1600 ms](/sketches/microservices/jitter.svg)

Only idempotent operations are retried. To retry a payment, the request carries an idempotency key, and the server executes it only once.

## Distributed Tracing

A single user request passes through the gateway and then the order, payment and stock services. Each service forwards the W3C standard `traceparent` header to the next one, and the logs come together around a single `trace-id`:

```text
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
               |  trace-id (whole request)         span-id (this step)
```

OpenTelemetry propagates this header automatically for HTTP clients and servers. Without it, finding an error across ten services turns into lining up ten different logs by timestamp by hand.

Every pattern comes at a price in code, infrastructure and complexity. Add each one when the problem actually appears, not in advance.
