---
title: "Git Bisect: Find the Bug in 10 Steps, Not 10 Hours"
date: "2025-12-28"
excerpt: "Binary search through your commit history to find exactly which commit broke things. Manual, automated, and CI-integrated approaches."
tags:
  - git
  - debugging
---

# Git Bisect: Find the Bug in 10 Steps, Not 10 Hours

Last month a colleague spent an entire afternoon scrolling through `git log`, checking out commits one by one, trying to find where a pricing calculation broke. The commit history had 847 commits since the last known good state. I showed him `git bisect` and we found the offending commit in under three minutes.

Binary search. That is all bisect is. But applied to your commit history, it is absurdly powerful.

## The Manual Approach

You need two things: a commit where things work (good) and a commit where things don't (bad). Git bisect binary-searches between them.

```bash
# Start bisecting
git bisect start

# Current HEAD is broken
git bisect bad

# This tag from two weeks ago was fine
git bisect good v2.4.0
```

Git checks out a commit halfway between good and bad. You test it. Then:

```bash
# If this commit works
git bisect good

# If this commit is broken
git bisect bad
```

Git narrows the range and checks out another commit. Repeat. With 847 commits, bisect needs at most `log2(847) = ~10` steps. Ten checkouts instead of 847.

When you are done:

```bash
# Git shows you the first bad commit
# Clean up and go back to where you were
git bisect reset
```

## The Real Story: A Pricing Bug

Here is what actually happened with that pricing bug. Our e-commerce platform started calculating VAT incorrectly for UK customers. No test caught it because the test was wrong too (the same commit changed both).

```bash
git bisect start
git bisect bad HEAD
git bisect good v2.3.0  # Last release where billing was verified

# Git says: Bisecting: 423 revisions left to test after this (roughly 9 steps)
```

At each step, I ran one command:

```bash
node -e "
  const { calculateVAT } = require('./src/pricing/tax');
  const result = calculateVAT({ amount: 100, country: 'GB' });
  process.exit(result === 20 ? 0 : 1);
"
```

If the exit code is 0, `git bisect good`. If 1, `git bisect bad`. After 9 steps, Git told me:

```
abc1234 is the first bad commit
Author: (redacted)
Date: Thu Nov 14 2025

    refactor: extract tax calculation into separate module
```

A "harmless refactor" had swapped the tax rate lookup. The original code used the shipping address country. The refactored version used the billing address country. For most customers these are the same. For the UK customer who had a US billing address, they were not.

## Automated Bisect: Let a Script Do It

Running the test manually at each step is tedious. `git bisect run` automates the whole thing:

```bash
git bisect start
git bisect bad HEAD
git bisect good v2.3.0

# Run this script at each step. Exit 0 = good, non-zero = bad.
git bisect run node -e "
  const { calculateVAT } = require('./src/pricing/tax');
  const result = calculateVAT({ amount: 100, country: 'GB' });
  process.exit(result === 20 ? 0 : 1);
"
```

Git runs the script, marks the commit, checks out the next one, repeats, and reports the first bad commit. You can walk away and get coffee.

For more complex tests, use a script file:

```bash
#!/bin/bash
# bisect-test.sh

# Some commits might not compile. Skip those.
npm run build 2>/dev/null
if [ $? -ne 0 ]; then
  exit 125  # 125 tells bisect to skip this commit
fi

# Run the specific failing test
npm test -- --grep "UK VAT calculation" 2>/dev/null
exit $?
```

```bash
git bisect run bash bisect-test.sh
```

Exit code 125 is special. It tells bisect "I cannot test this commit, skip it." This handles commits where the code does not compile or dependencies are missing.

## Bisect with a Test Suite

If you have a test that reproduces the bug, bisecting is a one-liner:

```bash
git bisect start HEAD v2.3.0 -- # start with bad and good in one line
git bisect run npm test -- --testPathPattern="pricing" --bail
```

The `--bail` flag makes Jest stop at the first failure, which speeds things up significantly. Without it, you wait for the entire test suite at every step.

## Handling Messy Histories

Real repositories have merge commits, reverts, and commits that do not build. Here is how I handle each:

### Commits That Don't Build

Use exit code 125 in your script as shown above. Bisect skips these and adjusts its search accordingly.

### Narrowing the Search Path

If you know the bug is in a specific directory:

```bash
git bisect start HEAD v2.3.0 -- src/pricing/
```

The `--` followed by a path tells bisect to only consider commits that touched those files. This can cut your search space dramatically.

### Viewing the Bisect Log

If you mess up and mark a commit incorrectly:

```bash
# See what you've done so far
git bisect log

# Save the log, reset, and replay with corrections
git bisect log > bisect.log
git bisect reset
# Edit bisect.log to fix the mistake
git bisect replay bisect.log
```

## Integrating Bisect with CI

I have a script that runs bisect inside CI when a regression is detected. The idea is simple: if a test that passed yesterday fails today, automatically bisect to find the cause.

```bash
#!/bin/bash
# ci-bisect.sh
# Usage: ./ci-bisect.sh <test-command> <last-known-good-sha>

TEST_CMD="$1"
GOOD_SHA="$2"

git bisect start HEAD "$GOOD_SHA"
git bisect run bash -c "$TEST_CMD"

# Capture the result
FIRST_BAD=$(git bisect log | grep "first bad commit" | head -1)

git bisect reset

echo "::error::Regression introduced by: $FIRST_BAD"

# Post to Slack (optional)
curl -X POST "$SLACK_WEBHOOK" \
  -H 'Content-Type: application/json' \
  -d "{\"text\": \"Regression found: $FIRST_BAD\"}"
```

In GitHub Actions:

```yaml
regression-bisect:
  runs-on: ubuntu-latest
  if: failure()
  needs: [test]
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0  # Need full history for bisect
    - run: |
        LAST_GREEN=$(gh run list --status success --limit 1 --json headSha -q '.[0].headSha')
        ./ci-bisect.sh "npm test -- --bail" "$LAST_GREEN"
```

The `fetch-depth: 0` is critical. By default, GitHub Actions does a shallow clone with only one commit. Bisect needs the full history.

## Advanced: Bisect by Date

Sometimes you do not know a specific good commit, but you know "it worked two weeks ago":

```bash
# Find a commit from two weeks ago
GOOD_COMMIT=$(git rev-list -1 --before="2 weeks ago" main)
git bisect start HEAD "$GOOD_COMMIT"
```

## Tips From Production Use

**Always bisect on a clean working tree.** Stash or commit your changes first. Bisect checks out commits, and uncommitted changes will conflict.

**Write the smallest possible test.** A test that takes 100ms per step means bisect finishes in 1 second. A test that takes 30 seconds per step means 5 minutes. Over 10 steps, this matters.

**Bisect the right branch.** If you bisect on `main` but the bug was introduced in a feature branch that was squash-merged, bisect will point to the squash commit. That is correct but not granular. If you need the specific commit within the feature branch, bisect on that branch before it was merged.

**Keep bisect in your debugging toolkit.** I am consistently surprised by how many senior engineers have never used it. It is the difference between "I spent all day looking for this" and "I found it in three minutes." Binary search works on your codebase just as well as it works on sorted arrays.

```bash
# My most-used bisect one-liner
git bisect start HEAD $(git rev-list -1 --before="1 week ago" HEAD) \
  && git bisect run bash -c "npm run build && npm test -- --bail"
```

That is it. Ten steps. Not ten hours.
