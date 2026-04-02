---
title: "Error Handling Patterns in Node.js: Stop Swallowing Errors"
date: "2025-10-05"
excerpt: "Empty catch blocks, generic error messages, and silent failures. Here are the patterns I use to handle errors properly in production Node.js applications."
tags:
  - nodejs
  - backend
  - best-practices
---

# Error Handling Patterns in Node.js: Stop Swallowing Errors

I once spent four hours debugging why user signups were silently failing. No errors in the logs. No failed requests. Users just never got their confirmation email. The root cause was this:

```javascript
try {
  await sendConfirmationEmail(user.email);
} catch (err) {
  // TODO: handle this later
}
```

"Handle this later" never came. The email service had changed its API, every call threw, and every error was swallowed. This is the most common error handling bug I see in production Node.js code, and it is entirely preventable.

## Custom Error Classes

The first step is distinguishing between error types. Not all errors are equal. A validation error and a database connection failure require completely different responses.

```javascript
class AppError extends Error {
  constructor(message, statusCode, code, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details = {}) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

class NotFoundError extends AppError {
  constructor(resource, id) {
    super(`${resource} not found`, 404, 'NOT_FOUND', { resource, id });
  }
}

class ConflictError extends AppError {
  constructor(message, details = {}) {
    super(message, 409, 'CONFLICT', details);
  }
}

class ExternalServiceError extends AppError {
  constructor(service, originalError) {
    super(`${service} service error`, 502, 'EXTERNAL_SERVICE_ERROR', {
      service,
      originalMessage: originalError.message,
    });
    this.cause = originalError;
  }
}
```

Now you can handle errors with precision:

```javascript
async function getUser(id) {
  const user = await User.findById(id);
  if (!user) throw new NotFoundError('User', id);
  return user;
}

async function createUser(data) {
  const existing = await User.findOne({ email: data.email });
  if (existing) throw new ConflictError('Email already registered');
  return User.create(data);
}
```

## Operational vs Programmer Errors

This distinction changed how I think about error handling. It comes from Joyent's original Node.js error handling guide and it is still the most useful framework I know.

**Operational errors** are expected failures: invalid user input, network timeout, file not found, rate limit exceeded. Your code is correct; the conditions are wrong. You handle these and move on.

**Programmer errors** are bugs: reading a property of `undefined`, passing a string where a number is expected, forgetting to `await` a promise. Your code is wrong. You cannot "handle" these meaningfully.

```javascript
function processPayment(order) {
  // Programmer error: this should never happen if callers are correct
  if (!order || !order.amount) {
    throw new Error('processPayment called without a valid order');
    // Don't throw AppError here. This is a bug, not a user error.
  }

  try {
    return paymentGateway.charge(order.amount);
  } catch (err) {
    // Operational error: the payment service is down or rejected the charge
    throw new ExternalServiceError('PaymentGateway', err);
  }
}
```

The key insight: operational errors should be caught and handled (retry, return error response, log and continue). Programmer errors should crash the process. If your code has a bug, continuing to serve requests is dangerous. Let it crash, let your process manager restart it, and fix the bug.

## Express Error Middleware

Express has a built-in error handling mechanism, but most teams underuse it. Any middleware with four arguments is an error handler:

```javascript
// This catches synchronous errors and errors passed to next(err)
app.use((err, req, res, next) => {
  // Log every error
  logger.error({
    message: err.message,
    code: err.code,
    stack: err.stack,
    path: req.path,
    method: req.method,
    requestId: req.id,
  });

  // Operational errors: send structured response
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  // Programmer errors: don't leak internals
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
});
```

## Async Error Boundaries

Express does not catch errors thrown in async route handlers. This crashes your server:

```javascript
// This will crash the process with an unhandled rejection
app.get('/users/:id', async (req, res) => {
  const user = await getUser(req.params.id); // Throws NotFoundError
  res.json(user);
});
```

You need a wrapper:

```javascript
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Now errors are forwarded to your error middleware
app.get('/users/:id', asyncHandler(async (req, res) => {
  const user = await getUser(req.params.id);
  res.json(user);
}));
```

Express 5 handles this natively. If you are on Express 4, this wrapper is essential. Without it, every unhandled rejection in a route handler is a potential crash.

## Structured Error Logging

Logging `err.message` is not enough. In production, you need structured logs that your log aggregator can search and alert on:

```javascript
const pino = require('pino');
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  serializers: {
    err: pino.stdSerializers.err,
  },
});

function logError(err, context = {}) {
  const logPayload = {
    err,
    errorCode: err.code,
    isOperational: err.isOperational || false,
    ...context,
  };

  if (err.isOperational) {
    logger.warn(logPayload, err.message);
  } else {
    logger.error(logPayload, err.message);
  }
}
```

This gives you structured JSON logs:

```json
{
  "level": 40,
  "time": 1696500000000,
  "err": {
    "type": "NotFoundError",
    "message": "User not found",
    "stack": "NotFoundError: User not found\n    at getUser (/app/src/users.js:15:11)..."
  },
  "errorCode": "NOT_FOUND",
  "isOperational": true,
  "requestId": "req_abc123",
  "userId": "usr_456",
  "msg": "User not found"
}
```

Now you can set up alerts: "if `isOperational: false` errors exceed 5 per minute, page the on-call engineer."

## Error Codes vs Messages

Messages change. Codes do not. Your API clients should never parse error messages.

```javascript
// Bad: client code parses the message
if (error.message.includes('not found')) { ... }

// Good: client code checks the code
if (error.code === 'NOT_FOUND') { ... }
```

I maintain a central error code registry:

```javascript
const ErrorCodes = {
  VALIDATION_ERROR: { status: 400, message: 'Validation failed' },
  UNAUTHORIZED: { status: 401, message: 'Authentication required' },
  FORBIDDEN: { status: 403, message: 'Insufficient permissions' },
  NOT_FOUND: { status: 404, message: 'Resource not found' },
  CONFLICT: { status: 409, message: 'Resource already exists' },
  RATE_LIMITED: { status: 429, message: 'Too many requests' },
  EXTERNAL_SERVICE_ERROR: { status: 502, message: 'External service unavailable' },
  INTERNAL_ERROR: { status: 500, message: 'Internal server error' },
};
```

This becomes your API's error contract. Document it. Version it. Never change the codes.

## The Unhandled Rejection Safety Net

Even with all these patterns, something will slip through. You need a last line of defense:

```javascript
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({
    err: reason,
    msg: 'Unhandled promise rejection - shutting down',
  });
  // Give the logger time to flush, then crash
  // Do NOT try to recover. An unhandled rejection means
  // your app is in an unknown state.
  setTimeout(() => process.exit(1), 1000);
});

process.on('uncaughtException', (err) => {
  logger.fatal({
    err,
    msg: 'Uncaught exception - shutting down',
  });
  setTimeout(() => process.exit(1), 1000);
});
```

Crashing might seem harsh. But an uncaught exception means something happened that no error handler anticipated. Continuing to serve requests with corrupted state is how you get data loss. Let the process crash, let Kubernetes restart it, and investigate the log.

## Putting It All Together

Here is how these patterns compose in a real route:

```javascript
app.post('/orders', asyncHandler(async (req, res) => {
  // Validation (throws ValidationError)
  const { error, value } = orderSchema.validate(req.body);
  if (error) throw new ValidationError('Invalid order data', {
    fields: error.details.map(d => d.message),
  });

  // Business logic (throws NotFoundError, ConflictError)
  const user = await getUser(req.user.id);
  const product = await getProduct(value.productId);

  if (product.stock < value.quantity) {
    throw new ConflictError('Insufficient stock', {
      available: product.stock,
      requested: value.quantity,
    });
  }

  // External service call (throws ExternalServiceError)
  let payment;
  try {
    payment = await paymentService.charge(user, value.amount);
  } catch (err) {
    throw new ExternalServiceError('PaymentService', err);
  }

  const order = await Order.create({ ...value, paymentId: payment.id });
  res.status(201).json(order);
}));
```

Every error has a type, a code, an appropriate status, and enough context to debug it. The error middleware handles the response. The route handler focuses on business logic.

The alternative is try-catch blocks everywhere, `res.status(500).json({ error: 'Something went wrong' })` scattered across 200 files, and engineers spending hours matching generic error messages in logs to specific failures. I have worked in both codebases. The difference is night and day.
