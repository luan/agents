---
name: vibe
description: "Runs the full QRDSPI delivery workflow as an orchestrator from intent to commit. Use when the user wants to vibe through a feature or delegate question, research, design, structure, implementation, critique, and commit with minimal interruption."
argument-hint: "<feature-or-task-intent> [--auto]"
user-invocable: true
---

# Vibe

## Quick start

Own the orchestration from intent to commit; let each phase own its local rules.

```text
$question (HITL) -> $research (AFK) -> $design (AFK) -> $structure (HITL, 10m timeout to AFK) -> repeat per open epic task: $implement (AFK) -> $crit (AFK) -> $commit
```

## Workflow

1. **Question / HITL** - run docs/code-grounded intake. Ask only questions that materially affect downstream work.
2. **Research / AFK** - gather and commit factual evidence. Pause only on contradiction or failed-closed review.
3. **Design / AFK** - choose a compact solution direction from the seeded context and research.
4. **Structure / HITL -> AFK** - draft a compact outline and gate it with a 10 minute timeout; continue from the draft if review times out without feedback.
5. **Implementation loop / AFK** - select one open epic task at a time. For each task: implement with repo discipline and targeted verification, critique the local changes, fix concrete defects, re-run verification, commit with a clear conventional message, then continue with the next open epic task.
