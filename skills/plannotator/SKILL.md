---
name: plannotator
description: Centralizes Plannotator review, gate, HTML render, and setup-goal browser sessions. Use whenever another skill needs to run `plannotator review`, `plannotator annotate`, or `plannotator setup-goal`.
user-invocable: true
---

# Plannotator

Use this skill for Plannotator browser sessions.

## Run pattern

Start Plannotator as a managed background terminal:

1. Run `exec_command` with the Plannotator command, `context_guard: false`, and
   a short `yield_time_ms`.
2. End the turn once Plannotator is running.
3. Resume work when the review or gate result is available.

## Code review

```bash
plannotator review
```

Before starting review, state what changed, where feedback is requested, and
anything intentionally left out.

Treat files or hunks staged by the user during Plannotator review as approved
review selections. Preserve the index exactly as the user left it unless they
ask for a staging change.

## Artifact gate

Resolve the artifact to its real absolute local filesystem path.

```bash
plannotator annotate "<absolute-path>" --gate --json
```

For rendered HTML:

```bash
plannotator annotate "<absolute-path>" --render-html --gate
```

For informational rendered HTML:

```bash
plannotator annotate "<absolute-path>" --render-html
```

## Setup-goal sessions

```bash
plannotator setup-goal interview goals/<slug>/interview.json --json
plannotator setup-goal facts goals/<slug>/facts-review.json --json
```

Write returned JSON to the matching result file before continuing.
