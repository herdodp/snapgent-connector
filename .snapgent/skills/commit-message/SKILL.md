---
name: commit-message
description: Use when the user asks to commit changes or write a git commit message. Gives the project's commit message format.
---

# Commit message

Follow these steps when asked to commit:

1. Run `git_status` and `git_diff` to see what changed.
2. Stage only the relevant files with `git_add` (never the whole workspace).
3. Write the message in this format:

```
<type>: <short summary, max 72 chars, imperative mood>

<optional body: what changed and why>
```

Allowed types: feat, fix, docs, refactor, test, chore.

4. Show the message to the user and wait for confirmation before calling `git_commit`.
