---
name: sym
description: 'Navigate code by symbol, references, callers, callees, implementations, and diffs via sym. Use when the user asks where code lives, how it is called, or what changed around a symbol.'
---

# sym — code navigation

**Default path:** use `sym <cmd>`. Text output is concise by default; use `sym --format ai <cmd>` for compact agent-readable evidence.

## Default loop

```
Orient → locate → inspect → relate → assess → targeted reads
```

1. **Orient** — `sym stats` and `sym map --level 2` before broad reading.
2. **Locate** — `sym query <symbol>` for friendly symbol lookup; use `sym search --text <pattern>` for literal text.
3. **Inspect** — `sym inspect <file>`, `sym show <symbol>`, or `sym investigate <symbol>`.
4. **Relate** — `sym callers`, `sym callees`, `sym impact`, `sym trace`, or `sym impls`.
5. **Assess** — `sym types`, `sym schema`, `sym tests`, `sym test-deps`, `sym untested`, and `sym diff`.
6. **Read** — after narrowing, use the read tool for source lines.

## Goal → command

| I want to…                               | Command                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| Build/update the source index            | `sym index [path]`                                                     |
| Orient in a repo                         | `sym stats`; `sym map --level 2`                                       |
| Find a symbol                            | `sym query <q>`                                                        |
| Search explicitly by symbol              | `sym search <q>`                                                       |
| Find text                                | `sym search --text <q>`                                                |
| Get kind-appropriate context             | `sym investigate <symbol>`                                             |
| Resolve symbol metadata                  | `sym show <symbol>`                                                    |
| List symbols in a file                   | `sym inspect <file>` or `sym outline <file>`                           |
| Find direct callers                      | `sym callers <symbol>`                                                 |
| Find direct callees                      | `sym callees <symbol>`                                                 |
| Find direct references                   | `sym refs <symbol>`                                                    |
| See who depends on a symbol transitively | `sym impact <symbol>`                                                  |
| See what a symbol calls                  | `sym trace <symbol>`                                                   |
| Find implementations/conformances        | `sym impls <symbol>`                                                   |
| Resolve signature types                  | `sym types <symbol>`                                                   |
| Inspect data fields                      | `sym schema <type>`                                                    |
| Find tests touching a symbol             | `sym tests <symbol>`                                                   |
| Find production deps called by a test    | `sym test-deps <test>`                                                 |
| Find symbols without indexed test refs   | `sym untested`                                                         |
| Scope a git diff to a symbol             | `sym diff <symbol> [base]`                                             |

Every command supports compact agent output with `sym --format ai <cmd>`.

## Examples

```bash
sym stats
sym map --level 2
sym query OpenStore
sym search parse --kind function --lang go
sym search --text "TODO"
sym search Handler --path 'internal/**' --exclude '**/*_test.go'
sym investigate OpenStore
sym show internal/index/store.go:OpenStore
sym inspect internal/index/store.go --signatures
sym callers ParseFile
sym callees ParseFile
sym refs ParseFile --file internal/
sym impact handleRegister --depth 3
sym trace handleRegister --kinds call,use
sym impls Handler
sym types handleRegister
sym schema Handler
sym tests handleRegister
sym test-deps test_handle_register
sym untested --lang go
sym diff ParseFile main --stat
```

## Guardrails

- Use `sym` before grep or broad reads when a symbol can be resolved directly.
- Use `outline` before reading a large file.
- Pivot to seam names such as registry, runtime, policy, session, store, descriptor, provider, or handler after two synonym searches.
- Narrow graph output with `--limit`, `--path`, or `--file`.

## Constraints

- `refs`, `impact`, and `trace` are best-effort code-index navigation, not full semantic analysis.
- Cross-package name collisions can inflate graph results; narrow by path or file.

## Outcome

Start with source navigation. Trust the first good rank. Read last.
