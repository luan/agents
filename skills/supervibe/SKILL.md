---
name: supervibe
description: 'Run the legacy multi-phase autonomous workflow over independent chunks. Use when the user explicitly asks for supervibe or a capped legacy autonomous pipeline.'
allowed-tools: Bash, Read, Glob, Grep, Skill
argument-hint: "<goal> [--max-iterations N]"
user-invocable: true
---

# Super Vibe

Break a goal into independent chunks informed by the spec, run each as a vibe cycle. Structured sequence, not a blind retry loop.

## Arguments

- `<goal>` — what to build (required)
- `--max-iterations N` — hard cap on vibe iterations (default: 5)

## Hard Caps

- **Max iterations**: 5 (override with `--max-iterations`)
- **Per-iteration**: each vibe cycle has its own token budget via `--max-budget-usd`
- Hit any cap → state what was accomplished, what remains, stop.

## [1] Spec

```
Skill("spec", args="<goal> --auto")
```

Read the spec file. The spec's Architecture Context tells you the scope — what modules, files, and patterns are involved.

## [2] Plan Chunks

Read the spec file via `ct vault read -t spec <path>`. Break the goal into 2-5 independent chunks based on the spec's Architecture Context. Each chunk:
- Can be implemented and tested independently
- Has a clear "done" state
- Fits in a single vibe cycle

Write the chunk plan as a simple numbered list. Each entry: one sentence describing what to build.

## [3] Execute Chunks

For each chunk, in order:

1. Output `[N/M] <chunk description>`
2. Run `Skill("vibe", args="<chunk prompt> --no-review")`
3. After vibe returns, verify: `git log --oneline -5` and `git diff --stat` to confirm progress
4. If vibe failed with zero progress, record the failure and move to the next chunk (don't retry the same chunk — the approach needs adjusting)

After all chunks complete, run one final review:
```
Skill("crit")
Skill("commit")
```

## [4] Handoff

```
Supervibe: <goal>
Chunks: N/M completed
Spec: <file path>
```

If max iterations hit before completion, state what remains.

## Error Handling

- Chunk fails → record it, continue to next chunk. Failed chunks are included in the final handoff.
- Max iterations hit → stop, state accomplished vs remaining.
- All chunks fail → stop, suggest `$diagnose` or manual investigation.
