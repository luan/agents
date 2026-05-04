---
name: vibe
description: 'Run the legacy autonomous spec-to-commit pipeline. Use when the user explicitly asks for vibe or wants the old end-to-end autonomous workflow.'
allowed-tools: Bash, Read, Glob, Skill
argument-hint: "<prompt> [--dry-run]"
user-invocable: true
---

# Vibe

Legacy full pipeline (spec → prepare → develop → review → commit) from a single prompt. This skill is intentionally thin until the autonomous workflow is redesigned.

## Arguments

- `<prompt>` — what to build (required)
- `--no-review` — skip review stage
- `--dry-run` — spec only, stop before develop

No prompt → tell user: `$vibe <what to build>`, stop.

## Pipeline

**Stage numbering `[N/M]`:** M = total stages that will run. Base: 5 (spec, prepare, develop, review, commit). `--no-review` → 4. `--dry-run` → 1.

### [1/M] Spec

Output `[1/M] Spec`.

```
Skill("spec", args="<prompt> --auto")
```

Spec runs silently with `--auto` and returns the spec file path or stem. Read the path directly from the spec output — do not fall back to a "find latest" lookup.

Verify the spec exists and has content. Immediately proceed to prepare.

### [2/M] Prepare

Output `[2/M] Prepare`.

If `--dry-run` → stop here. Output the spec file path and suggest `$prepare <spec-stem>`.

```
Skill("prepare", args="<spec-file-path-or-stem> --auto")
```

Prepare returns one or more task IDs. If multiple independent tasks are produced, run develop on the first unblocked AFK task only; leave the rest for explicit user orchestration until this skill is redesigned.

Verify the selected task exists and has content. Immediately proceed to develop.

### [3/M] Develop

Output `[3/M] Develop`.

```
Skill("develop", args="<task-id> --auto")
```

Verify the selected task's acceptance criteria were satisfied. If develop stops blocked, state the blocker and stop.

**Bugfix detection:** If the spec mentions "bug", "fix", "regression", or includes reproduction steps — after develop completes, re-run the reproduction scenario to confirm the fix works. If reproduction still fails, state the failure and stop (do not proceed to review with a broken fix).

Immediately proceed to review.

### [4/M] Review

Output `[4/M] Review`.

Skip if `--no-review`.

```
Skill("crit")
```

Fix any critical issues inline. Immediately proceed to commit.

### [5/M] Commit

Output `[5/M] Commit`.

If `git diff --stat` is empty → skip.

```
Skill("commit")
```

## Finalize

Output one line per stage (completed / skipped / failed).

## Error Handling

If a stage fails with zero progress:
1. State completed stages + failure details
2. Suggest: `/<failed-skill> [args]` to retry the failed stage
