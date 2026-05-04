---
name: vault
description: 'Find and read blueprints vault artifacts such as specs, plans, reviews, reports, docs, domain notes, and decision records. Use when the user asks for project context, prior decisions, product intent, specs, plans, vault docs, or documents related to a feature/topic.'
argument-hint: "<topic-or-stem> [--all-projects] [--archived]"
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
user-invocable: true
---

# Vault

Find and read blueprints vault artifacts with `ct vault`. Use this before relying only on code when the question is about product intent, historical context, vocabulary, decisions, specs, plans, reviews, or project documents.

## Quick start

```bash
ct vault search "<topic>"
ct vault read <stem>
ct vault related <stem-or-topic>
```

## Default discovery loop

1. **Search by topic words**

   ```bash
   ct vault search "<topic>"
   ct vault search --type doc "<domain term>"
   ct vault search --type spec "<feature>"
   ```

2. **List when search terms are unclear**

   ```bash
   ct vault list
   ct vault list --json
   ct vault list --all
   ```

3. **Read the best match**

   ```bash
   ct vault read <stem>
   ct vault read -t spec <stem>
   ct vault read --json <stem>
   ```

4. **Follow relationships**

   ```bash
   ct vault related <stem-or-topic>
   ct vault comments <stem>
   ```

5. **Validate against code only after vault context is clear**

   Use `ct source` for code navigation once you know the domain vocabulary, recorded decisions, and intended behavior.

## Goal → command

| I want to…                         | Command                                      |
| ---------------------------------- | -------------------------------------------- |
| Find artifacts about a topic       | `ct vault search "<topic>"`                  |
| Find only specs                    | `ct vault search --type spec "<topic>"`      |
| Find domain or decision docs       | `ct vault search --type doc "<term>"`        |
| Browse active artifacts            | `ct vault list`                              |
| Browse all projects                | `ct vault list --all`                        |
| Include archived search results    | `ct vault search --archive "<topic>"`        |
| Read by filename, path, or stem    | `ct vault read <stem-or-path>`               |
| Disambiguate a stem by type        | `ct vault read -t spec <stem>`               |
| Find adjacent artifacts            | `ct vault related <stem-or-topic>`           |
| Extract inline artifact comments   | `ct vault comments <stem>`                   |
| Check vault git and artifact state | `ct vault status`                            |

## What to read

- **Specs** for product intent, user stories, acceptance criteria, and non-goals.
- **Plans** for historical implementation breakdowns. Do not assume plans are current; verify with code/tasks.
- **Docs** for domain vocabulary, context boundaries, operating notes, and decisions.
- **Reviews/reports** for known risks, critiques, CI findings, or investigation results.
- **Inline comments** when resuming or preparing work from an existing artifact.

## Reporting results

When answering, cite artifact stems/titles clearly and distinguish:

- **Vault says** — documented intent, decisions, or vocabulary.
- **Code says** — current implementation verified with `ct source` or file reads.
- **Unclear/missing** — no matching artifact, stale plan, unresolved contradiction, or ambiguous stem.

## Don't

- Don't assume no document exists after one failed search. Try one synonym, list active artifacts, then stop.
- Don't edit, archive, retag, rename, or commit vault artifacts unless the user explicitly asks.
- Don't treat archived artifacts as current unless the user asks for history.
- Don't let a plan override a newer spec, task, decision doc, or code reality without calling out the conflict.
