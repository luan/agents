---
name: archive
description: "Archive consumed blueprint artifacts and preserve content in git notes."
argument-hint: "[<slug-or-path>] [--type <spec|plan|review|report>]"
allowed-tools:
  - Bash
  - Glob
user-invocable: true
---

# Archive

Move consumed blueprint artifacts to `archive/` and store their content as git notes for long-term retrieval.

## Agentic loop

1. **Intake** — Restate the requested outcome, inputs, constraints, and stop conditions. If the request is ambiguous or unsafe, ask before acting.
2. **Discover** — Gather the minimum evidence needed: user context, repo/vault state, relevant files, commands, docs, or external state. Prefer direct source/tool evidence over memory.
3. **Decide** — Choose the smallest valid path for `archive`. Name assumptions, blockers, and what is explicitly out of scope before side effects.
4. **Execute** — Identify consumed artifacts, preserve their content, archive only confirmed items, and verify notes/links remain recoverable.
5. **Verify** — Check the result against the request and this skill's rules using concrete evidence: tests, command output, diffs, links, artifacts, or reviewed findings.
6. **Close** — Provide only the concrete handoff the next actor needs: changed paths/artifacts/findings, verification status, remaining blockers, and the next command/action.

Guardrail: Archive only artifacts whose consumption evidence is concrete; preserve content in git notes before moving anything.

## Arguments

- `<slug-or-path>` — file path or slug substring to match
- `--type <spec|plan|review|report>` — restrict search to one artifact type (optional)
- No arguments → list active artifacts across all types, let user pick

## Workflow

### Without arguments

List active artifacts across all types:

```bash
ct vault list --all
```

Present the combined list and ask which to archive via AskUserQuestion.

### With slug argument

Search for matching artifact across types (or filtered by `-t <type>`):

```bash
# Try each type, find file whose name contains the slug
fd "<slug>" ~/blueprints/ --type f --extension md --exclude archive
```

If exactly one match → archive it. Multiple matches → present choices. No match → state no match and stop.

### Archive

Prefer `ct vault archive [-t <type>] <stem>`. It moves the file to `~/blueprints/<project>/archive/`, stores content as a git note, and commits+pushes.

CLI equivalent, useful for batch archival or previewing:

```bash
ct vault archive <file-path>                          # single (kind inferred from path)
ct vault archive -t <type> <slug>                     # restrict resolution to one kind
ct vault archive --batch <f1> <f2> <f3>               # one commit for all
ct vault archive --dry-run --batch <f1> <f2>          # preview, no writes
```

Output what was archived.
