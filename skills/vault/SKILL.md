---
name: vault
description: "Find and read blueprints vault artifacts from the command line such as research, plans and docs, domain notes, and decision records. Use when the user asks for CLI vault commands or command-line vault workflow help."
argument-hint: "<topic-or-stem> [--all-projects] [--archived]"
user-invocable: true
---

# Vault CLI

Command-line `vlt` workflows only. The Pi `vault_*` tools are self-documenting and do not need separate CLI guidance.

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

## Quick start

```bash
vlt index
vlt search "<topic>"
vlt similar <stem>
vlt read <stem>
vlt context list
vlt context show [name|map]
vlt links <stem>
vlt backlinks <stem>
```

## Discovery loop

1. Search by topic words.

   ```bash
   vlt index
   vlt list --type
   vlt search "<topic>"
   vlt context show
   vlt search --type decision "<decision term>"
   vlt search --type brief "<brief topic>"
   vlt search --type research "<feature>"
   vlt search --type <custom-type> "<topic>"
   vlt similar <stem>
   ```

2. List when search terms are unclear.

   ```bash
   vlt list
   vlt list --all
   vlt context list
   vlt context check
   ```

3. Read the best match.

   ```bash
   vlt read <stem-or-path>
   vlt read -t research <stem>
   vlt context show [name|map]
   ```

4. Follow relationships.

   ```bash
   vlt related <stem-or-topic>
   vlt links <stem>
   vlt backlinks <stem>
   vlt read <stem> --depth 2
   ```

5. Review structure when the vault feels stale or disconnected.

   ```bash
   vlt context check
   vlt graph --json
   vlt review
   ```

## Useful commands

| Goal                                  | Command                                     |
| ------------------------------------- | ------------------------------------------- |
| Find artifacts about a topic          | `vlt search "<topic>"`                                      |
| Rebuild local BM25 index              | `vlt index`                                                 |
| List available artifact types         | `vlt list --type`                                           |
| Find only research artifacts          | `vlt search --type research "<topic>"`                      |
| Find custom workflow artifacts        | `vlt search --type <custom-type> "<topic>"`                 |
| Find decision artifacts               | `vlt search --type decision "<term>"`                       |
| Find brief artifacts                  | `vlt search --type brief "<term>"`                          |
| Find similar artifacts                | `vlt similar <stem>`                                        |
| Browse active artifacts               | `vlt list`                                                  |
| Browse all projects                   | `vlt list --all`                                            |
| List project context docs             | `vlt context list`                                          |
| Read root project context             | `vlt context show`                                          |
| Read named project context            | `vlt context show <name>`                                   |
| Read context map                      | `vlt context show map`                                      |
| Update a glossary term                | `vlt context set <term> --definition "..."`                 |
| Validate context map/layout           | `vlt context check`                                         |
| Include archived search results       | `vlt search --archive "<topic>"`                            |
| Read by filename, path, or stem       | `vlt read <stem-or-path>`                                   |
| Read linked context                   | `vlt read <stem> --depth 2`                                 |
| Disambiguate a stem by type           | `vlt read -t research <stem>`                               |
| Find adjacent artifacts               | `vlt related <stem-or-topic>`                               |
| Show outgoing links                   | `vlt links <stem>`                                          |
| Show incoming links                   | `vlt backlinks <stem>`                                      |
| Export graph                          | `vlt graph --json`                                          |
| Review vault health                   | `vlt review`                                                |
| Add typed annotated link              | `vlt link <from> <to> --type implements --annotation "..."` |
| Append to artifact body               | `vlt update <stem> --append "..."`                          |
| Replace a section                     | `vlt update <stem> --replace-section "Why" --stdin`         |
| Create a typed artifact               | `vlt create --type <type> --topic "<topic>"`                |
| Check vault git and artifact state    | `vlt status`                                                |

## Rules

- Do not assume no document exists after one failed search. Try one synonym or list active artifacts.
- Do not edit, link, update, archive, retag, rename, or commit vault artifacts unless explicitly asked.
- Context docs are special: use `vlt context ...` for root `CONTEXT.md`, `CONTEXT-MAP.md`, and named `contexts/<name>/CONTEXT.md` workflows.
- Normal artifact filenames are stable numeric ids (`0001-topic.md`); creation dates belong in frontmatter.
- Treat artifact types as workflow-owned directory names. Built-ins are `research`, `design`, `structure`, `plan`, and `doc`/`docs`, but custom types like `brief`, `decision`, `review`, or `spec` are valid when a workflow needs them.
- Do not treat archived artifacts as current unless the user asks for history.
- Call out conflicts between vault intent, tasks, and code instead of silently choosing one.
- Prefer JSON output for mutating workflows; do not rely on truncated table identifiers.
