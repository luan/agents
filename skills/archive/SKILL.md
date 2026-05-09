---
name: archive
description: 'Archive consumed blueprint artifacts and preserve content in git notes. Use when blueprint artifacts are implemented, obsolete, or ready to move into archive/ without losing history.'
argument-hint: "[<slug-or-path>] [--type <research|plan|doc>]"
user-invocable: true
disable-model-invocation: true
---

# Archive

Move consumed blueprint artifacts to `archive/` and store their content as git notes for long-term retrieval.

## Arguments

- `<slug-or-path>` — file path or slug substring to match
- `--type <research|plan|doc>` — restrict search to one artifact type (optional)
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

State what was archived.
