---
name: vault
description: 'Find and read blueprints vault artifacts from the command line such as research, plans and docs, domain notes, and decision records. Use when the user asks for CLI vault commands or command-line vault workflow help.'
argument-hint: "<topic-or-stem> [--all-projects] [--archived]"
user-invocable: true
---

# Vault CLI

Command-line `ct vault` workflows only. The Pi `vault_*` tools are self-documenting and do not need separate CLI guidance.

## Quick start

```bash
ct vault search "<topic>"
ct vault read <stem>
ct vault related <stem-or-topic>
```

## Discovery loop

1. Search by topic words.

   ```bash
   ct vault search "<topic>"
   ct vault search --type doc "<domain term>"
   ct vault search --type research "<feature>"
   ```

2. List when search terms are unclear.

   ```bash
   ct vault list
   ct vault list --all
   ```

3. Read the best match.

   ```bash
   ct vault read <stem-or-path>
   ct vault read -t research <stem>
   ```

4. Follow relationships.

   ```bash
   ct vault related <stem-or-topic>
   ```

## Useful commands

| Goal                               | Command                                      |
| ---------------------------------- | -------------------------------------------- |
| Find artifacts about a topic       | `ct vault search "<topic>"`                 |
| Find only research/research artifacts  | `ct vault search --type research "<topic>"`     |
| Find domain or decision docs       | `ct vault search --type doc "<term>"`       |
| Browse active artifacts            | `ct vault list`                              |
| Browse all projects                | `ct vault list --all`                        |
| Include archived search results    | `ct vault search --archive "<topic>"`       |
| Read by filename, path, or stem    | `ct vault read <stem-or-path>`               |
| Disambiguate a stem by type        | `ct vault read -t research <stem>`               |
| Find adjacent artifacts            | `ct vault related <stem-or-topic>`           |
| Check vault git and artifact state | `ct vault status`                            |

## Rules

- Do not assume no document exists after one failed search. Try one synonym or list active artifacts.
- Do not edit, archive, retag, rename, or commit vault artifacts unless explicitly asked.
- Do not treat archived artifacts as current unless the user asks for history.
- Call out conflicts between vault intent, tasks, and code instead of silently choosing one.
