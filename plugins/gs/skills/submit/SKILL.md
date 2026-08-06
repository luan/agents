---
name: submit
description: Create or update Git-Spice change requests without duplicating remote work.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gs:*)"
  - "Bash(git status)"
  - Skill
---

# Submit Git-Spice changes

```bash
git status --short
gs log short
```

Update known remote work only:

```bash
gs stack submit --update-only --existing-only --no-web
```

This must fail before mutation when any selected branch lacks an exact change
request or upstream mapping. Add `--force` only when the user explicitly
authorizes the planned history rewrite.

Create remote branches or change requests only when requested:

```bash
gs stack submit --fill --no-web
```

Never substitute raw `git push` or forge-specific create commands. Verify the
reported change request identities after submission.
