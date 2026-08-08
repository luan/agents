---
name: vault
description: "Find and read blueprints vault artifacts from the command line such as research, plans and docs, domain notes, and decision records. Use when the user asks for CLI vault commands or command-line vault workflow help."
argument-hint: "<topic-or-stem> [--all-projects] [--archived]"
---

# Vault CLI

Command-line `vlt` workflows only. The Pi `vault_*` tools are self-documenting and do not need separate CLI guidance.

`vlt --help` and `vlt <command> --help` carry the command surface and every flag. Read them for syntax; this skill covers what they cannot tell you — the structure behind the commands, and how to move through a vault.

## Structural model

- **Context docs are special project structure**, not normal artifacts:
  - root context: `CONTEXT.md`
  - context map: `CONTEXT-MAP.md`
  - named contexts: `contexts/<name>/CONTEXT.md`
  - use `vlt context ...` for these files.
- **Normal artifacts are typed docs** under `<project>/<type>/0001-topic.md`.
  - type directories are workflow-owned; custom types are valid.
  - numeric stems are stable ids; creation dates belong in frontmatter.
  - use `vlt create/list/read/search/update/link/...` for these files.

Built-in types are `research`, `design`, `structure`, `plan`, and `doc`/`docs`. This workflow adds `spec`, `ticket`, `decision`, `wayfinder`, `wayfinding`, `prototype`, `brief`, and `review`.

## Discovery loop

1. **Search by topic words** — `vlt search "<topic>"`, narrowed with `--type` when you know the artifact kind. Run `vlt index` first if the vault has changed since the last search.
2. **List when search terms are unclear** — `vlt list`, `vlt list --all` for every project, `vlt context list` for the project's language.
3. **Read the best match** — `vlt read <stem-or-path>`, `-t <type>` to disambiguate a stem shared across types.
4. **Follow relationships** — `vlt related`, `vlt links`, `vlt backlinks`, or `vlt read <stem> --depth 2` to pull linked context in one call.
5. **Review structure when the vault feels stale or disconnected** — `vlt context check`, `vlt graph --json`, `vlt review`.

`vlt similar <stem>` finds neighbours by content when you have one good match and want its siblings.

## Rules

- After a failed search, try one synonym or list active artifacts before concluding no document exists.
- Read freely. Edit, link, update, archive, retag, rename, or commit vault artifacts when the user asks for it.
- Use `vlt context ...` for the context docs named above, and the artifact commands for everything else.
- Treat a numeric stem as the artifact's stable id; creation dates live in frontmatter.
- Treat artifact types as workflow-owned directory names — custom types are expected.
- Treat archived artifacts as history; confirm before presenting one as current.
- Call out conflicts between vault intent, tasks, and code instead of silently choosing one.
- Prefer JSON output for mutating workflows: identifiers in table output are truncated.
