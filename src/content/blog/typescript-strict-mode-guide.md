---
title: "TypeScript Strict Mode: Stop Using `any` and Start Shipping Safer Code"
date: "2026-01-20"
excerpt: "Every `any` in your codebase is a bug waiting to happen. Here's how to enable strict mode, survive the migration, and use TypeScript the way it was meant to be used."
tags:
  - typescript
  - best-practices
---

# TypeScript Strict Mode: Stop Using `any` and Start Shipping Safer Code

I joined a team that had 400+ uses of `any` in their TypeScript codebase. They also had a mysterious bug where user profiles would randomly show the wrong avatar. Turns out, a function typed as `any` was silently swapping user IDs and image URLs. Strict mode would have caught it at compile time. Instead, it made it to production and stayed there for three months.

## What Strict Mode Actually Enables

When you set `"strict": true` in `tsconfig.json`, it's a shorthand for these flags:

```json
{
  "compilerOptions": {
    "strict": true
    // Equivalent to ALL of these:
    // "strictNullChecks": true,
    // "noImplicitAny": true,
    // "strictFunctionTypes": true,
    // "strictBindCallApply": true,
    // "strictPropertyInitialization": true,
    // "noImplicitThis": true,
    // "alwaysStrict": true,
    // "useUnknownInCatchVariables": true
  }
}
```

Each flag closes a specific class of bugs. Let me walk through the ones that matter most.

## `strictNullChecks`: The Single Most Important Flag

Without this flag, `null` and `undefined` are assignable to every type. That means TypeScript won't warn you about the most common runtime error in JavaScript.

```typescript
// Without strictNullChecks - compiles fine, crashes at runtime
function getUser(id: string): User {
  return database.get(id); // might return undefined!
}

const user = getUser("abc");
console.log(user.name); // Runtime: Cannot read property 'name' of undefined
```

With `strictNullChecks`, the compiler forces you to handle the null case:

```typescript
function getUser(id: string): User | undefined {
  return database.get(id);
}

const user = getUser("abc");
// Error: Object is possibly 'undefined'
console.log(user.name);

// You must narrow first
if (user) {
  console.log(user.name); // Safe
}
```

This single flag eliminates an entire category of "Cannot read property of undefined" errors. Enable this one even if you skip everything else.

## `noImplicitAny`: Making Types Explicit

Without this flag, TypeScript silently infers `any` when it can't figure out the type. Your code looks typed but isn't.

```typescript
// Without noImplicitAny - 'item' is silently `any`
function processItems(items) {
  return items.map(item => item.naem); // Typo goes unnoticed
}
```

With the flag on, TypeScript demands you declare the type:

```typescript
interface Item {
  name: string;
  price: number;
}

function processItems(items: Item[]) {
  return items.map(item => item.naem);
  //                            ^^^^ Error: Property 'naem' does not exist on type 'Item'
}
```

That typo would have made it to production. Now it's caught before you even save the file.

## `unknown` vs `any`: The Right Way to Handle Uncertain Types

When you genuinely don't know the type, use `unknown` instead of `any`. The difference is critical: `unknown` forces you to validate before using, `any` lets you do whatever you want.

```typescript
// BAD: any lets you do anything without checking
function parseConfig(raw: any) {
  return raw.database.host; // No error, even if raw is a number
}

// GOOD: unknown forces you to narrow before accessing properties
function parseConfig(raw: unknown) {
  // return raw.database.host; // Error: Object is of type 'unknown'
}
```

For parsing external data, pair `unknown` with a validation library like Zod:

```typescript
import { z } from "zod";

const ConfigSchema = z.object({
  database: z.object({
    host: z.string(),
    port: z.number(),
  }),
});

function parseConfig(raw: unknown) {
  const config = ConfigSchema.parse(raw); // Throws if invalid
  return config.database.host; // Fully typed, fully validated
}
```

## Type Narrowing: Working With the Compiler

Strict mode means you'll be narrowing types constantly. Here are the patterns I use daily.

```typescript
// typeof narrowing
function formatValue(value: string | number) {
  if (typeof value === "string") {
    return value.toUpperCase(); // TypeScript knows it's a string here
  }
  return value.toFixed(2); // TypeScript knows it's a number here
}

// in narrowing - check for a property to distinguish union members
interface Dog { bark(): void }
interface Cat { meow(): void }
function makeNoise(animal: Dog | Cat) {
  if ("bark" in animal) { animal.bark(); } else { animal.meow(); }
}

// Assertion functions for custom narrowing
function assertDefined<T>(val: T | undefined, msg: string): asserts val is T {
  if (val === undefined) throw new Error(msg);
}
```

## Discriminated Unions: The Most Underused Pattern

This pattern alone justifies strict mode. It makes impossible states unrepresentable.

```typescript
// Instead of this mess:
interface ApiResponse {
  data?: User;
  error?: string;
  loading: boolean;
}
// Can data and error both be set? Can loading be true while data exists?

// Use discriminated unions:
type ApiResponse =
  | { status: "loading" }
  | { status: "success"; data: User }
  | { status: "error"; error: string };

function renderUser(response: ApiResponse) {
  switch (response.status) {
    case "loading":
      return "<Spinner />";
    case "success":
      return response.data.name; // TypeScript knows data exists
    case "error":
      return response.error; // TypeScript knows error exists
  }
}
```

The compiler enforces exhaustiveness. If you add a new status and forget to handle it, TypeScript will tell you.

```typescript
// Add exhaustiveness checking with a helper
function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${x}`);
}

function renderUser(response: ApiResponse) {
  switch (response.status) {
    case "loading":
      return "<Spinner />";
    case "success":
      return response.data.name;
    case "error":
      return response.error;
    default:
      return assertNever(response); // Compile error if a case is missing
  }
}
```

## Branded Types: Extra Safety for Primitive Values

This is an advanced pattern, but it's saved me from bugs where two values of the same primitive type get swapped.

```typescript
// The problem: both are strings, easy to mix up argument order
function transferMoney(fromAccountId: string, toAccountId: string, amount: number) {}

// The solution: branded types make plain strings/numbers incompatible
type AccountId = string & { readonly __brand: "AccountId" };
type USD = number & { readonly __brand: "USD" };

function accountId(id: string): AccountId { return id as AccountId; }
function usd(amount: number): USD { return amount as USD; }

function transfer(from: AccountId, to: AccountId, amount: USD) { /* ... */ }

transfer(accountId("acc_123"), accountId("acc_456"), usd(100)); // Works
transfer("acc_123", "acc_456", 100); // Error! Plain strings/numbers rejected
```

## Migrating an Existing Codebase

Don't enable `"strict": true` on a large codebase all at once. You'll get 2,000 errors and give up. Instead:

```json
{
  "compilerOptions": {
    "strictNullChecks": true
    // Start with one flag. Fix all errors. Then add the next.
  }
}
```

For the `any` cleanup: enable `noImplicitAny` first, add `@typescript-eslint/no-explicit-any` as an ESLint error to prevent new ones, use `// @ts-expect-error` for existing violations you can't fix yet, and chip away file by file.

Strict mode isn't about making TypeScript harder to use. It's about catching the bugs you'd otherwise find at 2 AM in production. Enable it. Fix the errors. Your future self will be grateful.
