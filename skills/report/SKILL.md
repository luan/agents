---
name: report
description: "Generate a post-implementation report summarizing what was built, correlating planned vs actual changes. Triggers: 'report', 'summarize implementation', 'what did we build', 'execution summary'."
argument-hint: "[--spec <spec-path>] [--plan <plan-path>]"
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
user-invocable: true
---

# Report

Generate a post-implementation summary as a blueprint artifact. Captures what was built, how it diverged from the plan, and what to watch for.

## Arguments

- `--spec <path>` — source spec to correlate against (optional)
- `--plan <path>` — source plan to correlate against (optional)
- No arguments → list candidates via `ct vault list -t plan` and `ct vault list -t spec`, ask the user to pick (or skip)

## Workflow

### 1. Gather context

```bash
BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/||' || echo main)
```

Collect:

- `git log --oneline $BASE..HEAD` — commit history
- `git diff --stat $BASE..HEAD` — file change summary
- `git diff $BASE..HEAD -- '*.rs' '*.ts' '*.py'` — actual diff (truncate at 3000 lines)

### 2. Read source artifacts

If `--spec` or `--plan` provided, read via `ct vault read -t spec <path>` / `ct vault read -t plan <path>`. Otherwise list candidates with `ct vault list -t spec` / `ct vault list -t plan` and ask the user which (if any) to correlate against — skip silently if the user opts out.

### 3. Synthesize report

**Sections:**

- **Summary**: 2-3 sentences — what was built and why.
- **Commits**: table of commits with one-line descriptions.
- **Files Changed**: grouped by area (e.g., src/, tests/, config/).
- **Plan vs Reality** (only if plan/spec available): what matched, what diverged, what was added that wasn't planned.
- **Watchouts**: things the next developer should know — incomplete work, known limitations, areas that need follow-up.

### 4. Store

Scaffold with the MCP `create` tool (kind=report), Edit the body, then `commit`.

### 5. Output

Print the report file path and a one-line summary.
