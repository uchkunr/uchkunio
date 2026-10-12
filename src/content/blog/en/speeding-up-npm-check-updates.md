---
title: "Making npm dependency checks 3x faster"
date: "2026-07-01"
excerpt: "npm-check-updates downloads the full history of every package it checks. Replacing that with a small request is easy, but the measurements showed that the real bottleneck was somewhere else."
tags:
  - nodejs
  - typescript
  - open-source
  - performance
---

`npm-check-updates` finds newer versions of the packages in a project. I use it almost every day, and on an average project I wait about three seconds for the result. To find out why, I started by looking at the requests it sends to the registry.

## What the registry returns

The npm registry offers two ways to get information about a package:

```bash
$ curl -s https://registry.npmjs.org/typescript | wc -c
15788071
$ curl -s https://registry.npmjs.org/typescript/latest | wc -c
4833
```

The first URL returns the package's entire history: every version, its dependencies and its release date. For `typescript` that comes to 15 megabytes of JSON. The second URL returns only the latest version.

![GET /typescript returns 15.8 MB, GET /typescript/latest returns 4.8 KB](/sketches/npm/payload.svg)

`ncu` uses the first URL, and for good reason: modes such as `--target minor` cannot work without the version history. Rewriting the request layer while keeping those features would be a large and risky change. I needed none of them, so I decided to write a small, separate tool.

## fast-ncu

The core work happens in a single function:

```ts
async function fetchLatestVersion(name: string): Promise<string | null> {
  const encodedName = name.startsWith("@")
    ? `@${encodeURIComponent(name.substring(1))}`
    : encodeURIComponent(name);

  const response = await fetch(`https://registry.npmjs.org/${encodedName}/latest`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry responded with status ${response.status}`);

  const data = (await response.json()) as { version?: string };
  return data.version ?? null;
}
```

For scoped packages the `/` has to be encoded, otherwise the registry does not understand the request: the URL for `@types/node` becomes `@types%2Fnode/latest`. The fetched versions are cached in a temporary file for five minutes, so running `-u` to update right after a check does not go back to the network:

```ts
const CACHE_FILE = path.join(os.tmpdir(), "fast-ncu-cache.json");
const DEFAULT_CACHE_TTL = 5 * 60 * 1000;
```

## What the measurements showed

I ran the test on a project with 78 dependencies, namely the `ncu` repository itself:

| Tool | Parallel requests | Time |
| --- | --- | --- |
| `ncu` | default | 2.75 s |
| `fast-ncu` | 15 | 2.70 s |
| `fast-ncu` | 30 | 0.88 s |

![Checking 78 dependencies: ncu 2.75 s, fast-ncu 2.70 s with 15 requests, 0.88 s with 30](/sketches/npm/race.svg)

Although the response size shrank by a factor of three thousand, the time in the second row barely changed. That means the time is spent not on downloading data but on waiting for each response:

```bash
$ curl -s -o /dev/null -w '%{time_total}\n' https://registry.npmjs.org/react/latest
0.304698
```

Even for a five-kilobyte response, the round trip takes 0.3 seconds. Under these conditions there is only one effective approach, which is to send more requests at once. Raising the number of parallel requests to 30 cut the time by a factor of three. A repeated check served from the cache finishes in 10 milliseconds, but that number cannot be compared with `ncu`, because in that case the tool does not touch the network at all.

```bash
npx fast-ncu
npx fast-ncu -u --concurrency 30
```

`fast-ncu` checks only the `latest` tag. If you need monorepo support, lockfiles or `--target minor`, `ncu` itself remains the right choice.
