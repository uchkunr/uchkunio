---
description: Audit all blog posts for frontmatter validity, slug correctness, and content issues.
---

Audit every file in `src/content/blog/` and report problems.

## How to run the audit

Use `find src/content/blog -name "*.md"` to get all posts, then read each one.

## What to check

For each post, verify:

### Frontmatter (required fields)
- `title` — present, non-empty string
- `date` — present, matches `YYYY-MM-DD` format, is a valid calendar date
- `excerpt` — present, non-empty, ideally ≤160 chars
- `tags` — present, is an array, each item is lowercase and hyphenated (no spaces, no uppercase)

### Frontmatter (optional fields)
- `cover` — if present, must be a valid URL string

### Slug (filename)
- Filename (without `.md`) must match: `^[a-z0-9][a-z0-9-]*[a-z0-9]$`
- No underscores, no uppercase, no date prefix

### Content
- File must have a `# H1` heading after the frontmatter
- H1 text should match `title` field (warn if different, not error)
- Code blocks should specify a language (warn on bare ` ``` ` fences)

## Output format

Print a table:

```
PASS  redis-beyond-caching.md
PASS  event-loop-deep-dive.md
WARN  docker-multi-stage-builds.md  — H1 "Docker Multi-Stage" doesn't match title "Docker Multi-Stage Builds"
FAIL  Bad_Post.md                   — invalid slug (uppercase/underscore)
FAIL  missing-fields.md             — missing: excerpt, tags
```

At the end, print a summary: `X posts, Y passed, Z warnings, W failures`.

If all posts pass: confirm clean with the count.
