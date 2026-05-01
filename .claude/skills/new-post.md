---
description: Scaffold a new blog post with correct frontmatter. Usage: /new-post <title>
---

Create a new blog post in `src/content/blog/`.

## Steps

1. **Derive the slug** from the title: lowercase, spaces → hyphens, strip special characters. Example: "Redis Beyond Caching" → `redis-beyond-caching`.

2. **Check for conflicts**: confirm `src/content/blog/<slug>.md` does not already exist.

3. **Create the file** at `src/content/blog/<slug>.md` with this exact structure:

```markdown
---
title: "<exact title from user>"
date: "<today's date in YYYY-MM-DD>"
excerpt: "<one or two sentences summarising the post — written as a statement, not a teaser>"
tags:
  - <primary-tag>
  - <secondary-tag>
---

# <exact title from user>

<Write the post here. Real technical depth, real code examples with language-tagged fences, short intro, no filler conclusion.>
```

4. **Report back**: print the file path and slug so the user knows the URL will be `/blog/<slug>`.

## Frontmatter rules

- `date`: use today's date (`currentDate` from context if available)
- `excerpt`: max ~160 chars, no trailing ellipsis, written as a complete statement
- `tags`: 2–4 tags, all lowercase, hyphenated if multi-word (e.g. `rate-limiting`)
- `cover`: omit unless user provides an image URL

## Slug rules

Only lowercase letters `a-z`, digits `0-9`, and hyphens `-`. No underscores, no dates in the slug.

Valid: `event-loop-deep-dive`  
Invalid: `Event_Loop_Deep_Dive`, `2026-01-event-loop`
