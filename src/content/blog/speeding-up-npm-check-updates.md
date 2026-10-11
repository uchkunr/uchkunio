---
title: "How I Sped Up npm-check-updates by 3x (and Built a 300x Faster Alternative)"
date: "2026-07-01"
excerpt: "I wanted a faster way to check for dependency updates. So I cloned npm-check-updates, analyzed its bottlenecks, and decided to build a lightweight alternative from scratch."
tags:
  - nodejs
  - typescript
  - open-source
  - performance
---

I use `npm-check-updates` (commonly run as `ncu`) almost daily to keep my project dependencies fresh. It's an excellent, feature-rich tool. But recently, I found myself waiting 3 to 5 seconds every time I ran it on a medium-sized project. On a slower internet connection, the wait was even more noticeable.

As developers, we hate waiting. So I decided to dig into the codebase and see if I could speed it up.

## The Plan: Clone, Fix, and PR

My initial goal was simple: clone the `npm-check-updates` repository, find the performance bottlenecks, submit a pull request, and make the tool faster for everyone. 

I cloned the repo, set up the development environment, and began tracing the execution path. It didn't take long to find why the tool takes its time:

1. **Heavy Dependency Boot Overhead:** `ncu` is a Swiss Army knife. It supports multiple package managers (npm, yarn, pnpm, deno), monorepos, lockfile updates, and complex matching strategies. To support all this, it loads a massive dependency graph (including packages like `pacote`, `npm-registry-client` wrappers, and various utilities). Just booting Node.js and parsing these imports takes 150ms–300ms before a single network request is even sent.
2. **Gigantic Registry Payloads:** By default, `ncu` fetches the full package metadata (known as a "packument") from `https://registry.npmjs.org/<pkg>`. For packages with long histories (like `typescript`, `aws-sdk`, or `lodash`), this JSON payload can be **several megabytes**. Downloading, parsing, and GC-ing megabytes of JSON just to extract the single "latest" version string is a huge bottleneck.

### The Realization

Fixing this within the original repository was going to be an uphill battle. 

Changing the metadata fetching strategy would require replacing or heavily refactoring `pacote`. However, `ncu` actually *needs* the full version history to support features like `--target minor` (finding the latest minor release) or `--target greatest` (finding the highest version, including pre-releases). 

If I wanted to change the fetching strategy to only pull down the latest version, it would either break these features or require building a complex, conditional fetching layer. Convincing the maintainers to accept a massive refactor that might break edge cases would take weeks of discussion, review, and back-and-forth.

But I didn't need 95% of those edge cases. I just wanted a tool that would check if my dependencies were out of date and update my `package.json` as fast as humanly possible. 

So I decided to build a lightweight, ESM-native, zero-dependency alternative from scratch: [fast-ncu](https://github.com/uchkunr/fast-ncu).

---

## How `fast-ncu` Achieves Extreme Performance

To make it as fast as possible, I focused on eliminating the bottlenecks I discovered in the original codebase.

### 1. Tiny Payloads via the `/latest` Endpoint
Instead of querying `https://registry.npmjs.org/<pkg>`, `fast-ncu` queries the CDN-cached edge endpoint:
```
https://registry.npmjs.org/<pkg>/latest
```
This endpoint returns a tiny JSON object (~2KB) containing only the latest version details. It is cached heavily on npm's CDN edges and resolves in a fraction of the time compared to the full packument.

### 2. A Zero-Dependency Concurrency Limiter
Since Node's native `fetch` doesn't limit concurrency, firing 80 registry requests at once can easily saturate network sockets or trigger npm registry rate limits. 

Instead of pulling in a heavy external library, I wrote a tiny, zero-dependency concurrency helper directly in the source:

```typescript
async function pLimit<T>(concurrency: number, tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = [];
  const executing: Promise<void>[] = [];
  let i = 0;
  
  async function runTask(taskIndex: number) {
    results[taskIndex] = await tasks[taskIndex]();
  }

  const enqueue = async (): Promise<void> => {
    if (i === tasks.length) return;
    const currentIdx = i++;
    const promise = runTask(currentIdx).then(() => {
      executing.splice(executing.indexOf(promise), 1);
    });
    executing.push(promise);
    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
    await enqueue();
  };

  await enqueue();
  await Promise.all(executing);
  return results;
}
```

This lets us run requests in parallel with a configurable limit (defaulting to 15, but easily cranked up to 30 or more), keeping the network pipe full without dropping packets.

### 3. Native ESM and Zero Bloat
The package uses native ES Modules and avoids heavy CLI frameworks like `yargs` or `commander`. The only production dependencies are `semver` (for range matching) and `picocolors` (for terminal colors). 

Because of this, the startup time of the Node process is practically instant (~40ms).

### 4. Smart Local Cache
Subsequent runs within a project are instantaneous. It stores the fetched package versions in the system's temp directory (`fast-ncu-cache.json`) for 5 minutes (customizable). 

If you run it a second time to upgrade or double-check, it doesn't hit the network at all. The check completes in **10 milliseconds**.

---

## The Results: Benchmarks

I ran a benchmark comparing the original `ncu` and `fast-ncu` on a repository containing **78 dependencies** (ironically, the `npm-check-updates` repository itself):

<div class="overflow-x-auto my-6 border border-border rounded-lg">
  <table class="w-full text-left border-collapse text-sm">
    <thead>
      <tr class="border-b border-border bg-muted/30">
        <th class="p-3 font-semibold text-foreground">Tool</th>
        <th class="p-3 font-semibold text-foreground">Concurrency</th>
        <th class="p-3 font-semibold text-foreground">Cache</th>
        <th class="p-3 font-semibold text-foreground">Time (Seconds)</th>
        <th class="p-3 font-semibold text-foreground">Speedup</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-border">
      <tr>
        <td class="p-3 text-muted-foreground">🐢 Original <code>ncu</code></td>
        <td class="p-3 text-muted-foreground">Default</td>
        <td class="p-3 text-muted-foreground">N/A</td>
        <td class="p-3 text-muted-foreground font-mono">2.75s</td>
        <td class="p-3 text-muted-foreground italic">Baseline</td>
      </tr>
      <tr>
        <td class="p-3 text-muted-foreground">⚡ <code>fast-ncu</code> (Cold)</td>
        <td class="p-3 text-muted-foreground">15 (Default)</td>
        <td class="p-3 text-muted-foreground">Disabled</td>
        <td class="p-3 text-muted-foreground font-mono">2.70s</td>
        <td class="p-3 text-muted-foreground">1.0x</td>
      </tr>
      <tr class="bg-primary/5">
        <td class="p-3 text-foreground font-medium">🚀 <code>fast-ncu</code> (Cold)</td>
        <td class="p-3 text-foreground font-medium">30</td>
        <td class="p-3 text-muted-foreground">Disabled</td>
        <td class="p-3 text-foreground font-semibold font-mono">0.88s</td>
        <td class="p-3 text-foreground font-semibold">3.1x faster</td>
      </tr>
      <tr class="bg-primary/5">
        <td class="p-3 text-foreground font-medium">🛸 <code>fast-ncu</code> (Warm)</td>
        <td class="p-3 text-foreground font-medium">30</td>
        <td class="p-3 text-green-600 dark:text-green-400 font-medium">Enabled (Hit)</td>
        <td class="p-3 text-foreground font-semibold font-mono">0.01s (10ms)</td>
        <td class="p-3 text-foreground font-semibold text-green-600 dark:text-green-400">275x+ faster</td>
      </tr>
    </tbody>
  </table>
</div>

By raising the concurrency limit to `30`, `fast-ncu` finishes the check in under a second on a cold run. On a warm run, it's virtually instant.

---

## Trying it Out

If you want to try it out on your own projects, you can run it on the fly with `npx`:

```bash
npx fast-ncu
```

Or install it globally:

```bash
npm install -g fast-ncu
```

Options are kept simple:
* `fast-ncu -u` upgrades your `package.json` file.
* `fast-ncu --concurrency 30` increases parallel fetches.
* `fast-ncu --no-cache` forces a fresh registry lookup.

Sometimes, the best way to speed up a tool is to strip away the features you don't use and build a hyper-focused version of it. The source code is open and available on [GitHub](https://github.com/uchkunr/fast-ncu). Feel free to check it out or contribute!
