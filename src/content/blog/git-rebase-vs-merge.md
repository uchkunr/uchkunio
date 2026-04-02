---
title: "Git Rebase vs Merge: When to Use Which"
date: "2026-01-10"
excerpt: "A practical guide to rebase vs merge from someone who's destroyed production history and lived to tell about it. Interactive rebase, fixup, squash, and real team workflows."
tags:
  - git
  - workflow
---

# Git Rebase vs Merge: When to Use Which

I once force-pushed a rebase to a shared branch and wiped out three days of a colleague's work. That was 2019. I've since developed strong opinions about when to rebase and when to merge, and every one of those opinions was earned the hard way.

## The Core Difference in 30 Seconds

**Merge** creates a new commit that combines two branches. History stays intact, warts and all.

**Rebase** rewrites your commits on top of another branch. Cleaner history, but you're rewriting commits.

```bash
# Merge: preserves the full branch topology
git checkout main
git merge feature/auth

# Rebase: replays your commits on top of main
git checkout feature/auth
git rebase main
```

After a merge, `git log --graph` shows the branch and merge point. After a rebase, it looks like everything happened sequentially. Neither is inherently better.

## When Merge Is the Right Call

Use merge when you're working on a **shared branch** or when the branch history itself tells a story.

```bash
# This is safe. Always safe. Nobody loses work.
git checkout main
git merge --no-ff feature/payment-refactor
```

The `--no-ff` flag forces a merge commit even if fast-forward is possible. I use this on every team branch merge because it creates an explicit record: "this feature was developed on a branch and merged at this point."

Merge is also your friend when:
- Multiple people are pushing to the same branch
- You want to preserve the exact sequence of commits for auditing
- You're merging long-lived branches (release branches, hotfixes)

## When Rebase Is the Right Call

Rebase shines for **local cleanup before sharing your work**. Think of it as editing your draft before publishing.

```bash
# You've been working on a feature branch for a week.
# Main has moved forward. Before opening a PR:
git checkout feature/user-search
git rebase main

# Now your branch looks like it was started from current main.
# Clean diff, easy review.
```

The golden rule: **never rebase commits that have been pushed to a shared branch**. If someone else has based work on those commits, rebase rewrites the commit hashes and their branch now points to ghosts.

## Interactive Rebase: The Power Tool

This is where rebase becomes indispensable. Interactive rebase lets you edit, squash, reorder, and drop commits before they become part of the shared history.

```bash
# Rebase the last 4 commits interactively
git rebase -i HEAD~4
```

This opens your editor with something like:

```
pick a1b2c3d Add user search endpoint
pick e4f5g6h Fix typo in search query
pick i7j8k9l Add pagination to search
pick m0n1o2p Fix off-by-one in pagination
```

Now you can reshape history:

```
pick a1b2c3d Add user search endpoint
fixup e4f5g6h Fix typo in search query
pick i7j8k9l Add pagination to search
fixup m0n1o2p Fix off-by-one in pagination
```

**`fixup`** merges the commit into the previous one and discards its message. **`squash`** does the same but lets you combine the messages. The result: two clean commits instead of four, with the typo fixes absorbed into the real work.

### My Favorite Interactive Rebase Patterns

**Pattern 1: The "oops" absorber**

You committed, then realized you forgot a file. Instead of a "forgot to add utils" commit:

```bash
# Stage the forgotten file
git add src/utils/search.ts

# Commit it with fixup targeting the original commit
git commit --fixup=a1b2c3d

# Now autosquash it
git rebase -i --autosquash HEAD~3
```

The `--fixup` flag creates a commit prefixed with `fixup!` and `--autosquash` automatically reorders it next to its target. No manual editor juggling.

**Pattern 2: Splitting a commit**

Sometimes you realize one commit does two unrelated things.

```bash
git rebase -i HEAD~3
# Mark the commit as "edit"
# Git will pause at that commit
git reset HEAD~1
# Now stage and commit the pieces separately
git add src/auth/*
git commit -m "Add JWT validation middleware"
git add src/logging/*
git commit -m "Add structured logging to auth flow"
git rebase --continue
```

**Pattern 3: Reordering for a cleaner story**

Your commits happened in the order you worked, but that's not the order that makes sense for a reviewer. Just reorder the lines in the interactive rebase editor.

## The Workflow I Use on Every Team

After years of merge-vs-rebase debates, here's what actually works:

```
1. Create feature branch from main
2. Commit freely (WIP commits are fine)
3. When ready for PR:
   a. git fetch origin main
   b. git rebase -i origin/main  (clean up commits)
   c. git push --force-with-lease  (safe force push to YOUR branch)
4. PR gets reviewed
5. Merge to main with --no-ff (merge commit on main)
```

The key detail is `--force-with-lease` instead of `--force`. It refuses to push if the remote has commits you haven't seen, preventing you from overwriting someone else's work on your branch.

```bash
# NEVER do this
git push --force origin feature/my-branch

# ALWAYS do this instead
git push --force-with-lease origin feature/my-branch
```

## When Rebase Goes Wrong

Rebase conflicts can be more painful than merge conflicts because you resolve them commit-by-commit instead of all at once. If you're rebasing 15 commits and each one conflicts, you're resolving 15 rounds of conflicts.

When this happens, consider aborting and using merge instead:

```bash
# Escape hatch during a painful rebase
git rebase --abort

# Just merge instead
git merge main
```

There's no shame in this. A merge commit is better than a botched rebase.

### Recovering from a Bad Rebase

If you rebase and everything looks wrong, `reflog` is your safety net:

```bash
# See where your branch was before the rebase
git reflog

# Output looks like:
# a1b2c3d HEAD@{0}: rebase (finish): returning to refs/heads/feature/auth
# e4f5g6h HEAD@{1}: rebase (pick): Add auth middleware
# f7g8h9i HEAD@{2}: rebase (start): checkout main
# j0k1l2m HEAD@{3}: commit: Add auth middleware   <-- this is pre-rebase

# Reset to pre-rebase state
git reset --hard HEAD@{3}
```

The reflog keeps everything for 90 days by default. You can always get back to where you were.

## Rebase and CI: A Subtle Trap

Here's something that bit my team: if your CI runs on the PR branch and you rebase, the CI results for the old commits are invalidated. The commit hashes changed, so GitHub/GitLab shows the checks as pending again.

This means rebasing right before merge can delay your merge while CI re-runs. Plan for this by rebasing before final review, not after approval.

## My Rules of Thumb

1. **Rebase your own unpushed work freely.** It's your local history.
2. **Rebase your own pushed-but-unshared feature branch** with `--force-with-lease`.
3. **Never rebase a branch someone else is working on.** Use merge.
4. **Use interactive rebase to clean up before PR.** Your reviewers will thank you.
5. **Merge to main.** The merge commit marks the integration point.
6. **When in doubt, merge.** You can't lose work with merge. You can with rebase.

The merge-vs-rebase debate doesn't have to be religious. Use both. Rebase is for polishing your work before sharing it. Merge is for integrating shared work. Once you internalize that distinction, the decision becomes obvious in every situation.
