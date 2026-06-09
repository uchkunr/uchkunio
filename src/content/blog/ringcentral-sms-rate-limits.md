---
title: "RingCentral SMS Integration: Rate Limits, Queues, and Circuit Breakers"
date: "2026-06-05"
excerpt: "Sending SMS through RingCentral without hitting rate limits or dropping messages — token management, BullMQ queues, Retry-After parsing, and circuit breakers that actually work."
tags:
  - ringcentral
  - typescript
  - rate-limiting
---

# RingCentral SMS Integration: Rate Limits, Queues, and Circuit Breakers

RingCentral's SMS API has a rate limit of ~40 messages per minute per number. When your app sends lead notifications at volume, that limit is easy to hit — and the default behavior of most HTTP clients (throw an error, let the caller retry immediately) guarantees you'll hit it repeatedly.

Here's how to build a queue-based SMS sender that handles rate limits, token expiry, and partial failures correctly.

## Understanding the Rate Limit Response

RingCentral returns two useful pieces of information on every SMS response:

```http
HTTP/1.1 200 OK
X-Rate-Limit-Remaining: 12
X-Rate-Limit-Window: 60
```

And on a 429:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 45
```

The `Retry-After` header is your main signal. But RingCentral sometimes embeds it in the error body instead of the header:

```json
{
  "errorCode": "CMN-301",
  "message": "Request rate exceeded. Retry-After: 45"
}
```

Parse both:

```typescript
function extractRetryAfter(err: RingCentralError): number {
  const fromHeader = err.response?.headers?.['retry-after'];
  if (fromHeader) return parseInt(fromHeader);

  const match = err.message?.match(/Retry-After:\s*(\d+)/i);
  if (match) return parseInt(match[1]);

  return 60; // safe default
}
```

## Wrapping the RingCentral SDK

Keep the SDK behind a thin wrapper that returns rate limit info alongside the message ID:

```typescript
interface SmsResult {
  messageId: string;
  rateLimitRemaining: number;
  rateLimitWindow: number;
}

async function sendSms(
  accessToken: string,
  from: string,
  to: string,
  text: string
): Promise<SmsResult> {
  const rc = new RingCentral({ server: process.env.RC_SERVER_URL });
  rc.token = { access_token: accessToken };

  const response = await rc
    .restapi('v1.0')
    .account()
    .extension()
    .sms()
    .post({
      from: { phoneNumber: toE164(from) },
      to: [{ phoneNumber: toE164(to) }],
      text,
    });

  return {
    messageId: response.id!,
    rateLimitRemaining: parseInt(
      response.headers?.['x-rate-limit-remaining'] ?? '99'
    ),
    rateLimitWindow: parseInt(
      response.headers?.['x-rate-limit-window'] ?? '60'
    ),
  };
}
```

## BullMQ Queue for Reliable Delivery

Synchronous SMS sending in a request handler is a mistake — if the HTTP connection drops, you don't know if the SMS was sent. Queue it instead:

```typescript
import { Queue, Worker, Job } from 'bullmq';

interface SmsJob {
  userId: string;
  to: string;
  text: string;
  leadId: string;
}

const smsQueue = new Queue<SmsJob>('sms', {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: false,
  },
});

// Enqueue from your lead assignment handler
async function enqueueLeadSms(leadId: string, userId: string): Promise<void> {
  const [lead, user] = await Promise.all([
    prisma.lead.findUniqueOrThrow({ where: { id: leadId } }),
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
  ]);

  await smsQueue.add(
    'send',
    { userId, to: lead.phone, text: renderSmsTemplate(lead, user), leadId },
    { jobId: `sms:${leadId}:${userId}` } // idempotency key
  );
}
```

The `jobId` prevents duplicate enqueues if your lead assignment logic runs twice for the same lead/user pair.

## The Worker

```typescript
const smsWorker = new Worker<SmsJob>(
  'sms',
  async (job: Job<SmsJob>) => {
    const { userId, to, text } = job.data;

    if (circuitBreaker.isOpen()) {
      throw new Error('Circuit breaker open — deferring SMS');
    }

    const token = await getAccessToken(userId); // from token service

    let result: SmsResult;
    try {
      result = await sendSms(token, await getUserPhone(userId), to, text);
      circuitBreaker.recordSuccess();
    } catch (err) {
      circuitBreaker.recordFailure(err as Error);

      if (isRateLimit(err)) {
        const retryAfter = extractRetryAfter(err as RingCentralError);
        // BullMQ respects `delay` on throw — push the job back N seconds
        await job.moveToDelayed(Date.now() + retryAfter * 1000);
        return;
      }

      if (isTokenRevoked(err)) {
        await clearRingCentralToken(userId);
        // Don't retry — user must re-auth
        throw new UnrecoverableError('RingCentral token revoked');
      }

      throw err; // retriable error — BullMQ handles backoff
    }

    // Back off proactively when rate limit is low
    if (result.rateLimitRemaining === 0) {
      await smsQueue.pause();
      setTimeout(() => smsQueue.resume(), result.rateLimitWindow * 1000);
    }

    await prisma.smsLog.create({
      data: {
        leadId: job.data.leadId,
        userId,
        messageId: result.messageId,
        sentAt: new Date(),
      },
    });
  },
  { connection: redis, concurrency: 5 }
);
```

Two rate-limit strategies working together:
- **Reactive**: When a 429 arrives, use `moveToDelayed` to push the specific job back by exactly `Retry-After` seconds.
- **Proactive**: When `X-Rate-Limit-Remaining` hits 0, pause the whole queue for the duration of the rate window.

## Circuit Breaker

The circuit breaker prevents a degraded RingCentral API from draining your retry budget on every job:

```typescript
class SmsCircuitBreaker {
  private consecutiveFailures = 0;
  private openUntil = 0;
  private readonly threshold = 10;
  private readonly cooldown = 120_000; // 2 minutes

  isOpen(): boolean {
    if (Date.now() >= this.openUntil) {
      this.consecutiveFailures = 0; // reset after cooldown
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(err: Error): void {
    // Don't count rate limits — those are expected
    if (isRateLimit(err)) return;

    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.threshold) {
      this.openUntil = Date.now() + this.cooldown;
      logger.warn(
        { until: new Date(this.openUntil) },
        'SMS circuit breaker opened'
      );
    }
  }
}
```

Rate limit errors don't count toward the failure threshold — they're expected behavior, not a sign that the API is broken.

## Token Errors vs. API Errors

RingCentral uses specific error codes for token problems:

```typescript
function isTokenRevoked(err: unknown): boolean {
  const msg = (err as RingCentralError)?.message ?? '';
  return (
    msg.includes('OAU-211') || // token not found
    msg.includes('OAU-213')    // token revoked
  );
}

function isRateLimit(err: unknown): boolean {
  return (err as RingCentralError)?.response?.status === 429;
}
```

`OAU-211` and `OAU-213` mean the token is gone — retrying with the same token will always fail. Mark the job as unrecoverable (`UnrecoverableError` in BullMQ skips retries), clear the cached token, and surface an alert so someone can re-authorize.

## E.164 Formatting

RingCentral rejects phone numbers that aren't in E.164 format. Users enter numbers like `(555) 123-4567` — normalize them before every call:

```typescript
function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');

  // US numbers without country code
  if (digits.length === 10) return `+1${digits}`;

  // Already has country code
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;

  // International
  if (digits.length > 11) return `+${digits}`;

  throw new Error(`Cannot normalize phone number: ${phone}`);
}
```

## What the Queue Buys You

Without the queue:
- SMS sending is synchronous in the request path
- A rate limit 429 fails the user's action
- A crashed worker loses the message

With the queue:
- Lead assignment returns immediately
- Failed sends retry automatically with backoff
- Rate limit delays push the job back without losing it
- The job log gives you a full audit trail of every SMS attempt

The worker concurrency is set to 5 — low enough to stay comfortably under the 40 msg/min limit for a single number, while still processing bursts quickly.
