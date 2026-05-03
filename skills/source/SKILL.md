---
name: source
description: "Canonical code navigator for symbols, refs, callers/callees, implementations, and symbol diffs."
---

# source — code navigation

**Default path:** use `ct source <cmd>`. Text output is concise by default; add `--json` only when a machine-readable result is useful.

## Agentic loop

1. **Intake** — Restate the requested outcome, inputs, constraints, and stop conditions. If the request is ambiguous or unsafe, ask before acting.
2. **Discover** — Gather the minimum evidence needed: user context, repo/vault state, relevant files, commands, docs, or external state. Prefer direct source/tool evidence over memory.
3. **Decide** — Choose the smallest valid path for `source`. Name assumptions, blockers, and what is explicitly out of scope before side effects.
4. **Execute** — Answer code navigation questions with canonical symbol/source lookups and concrete references.
5. **Verify** — Check the result against the request and this skill's rules using concrete evidence: tests, command output, diffs, links, artifacts, or reviewed findings.
6. **Close** — Provide only the concrete handoff the next actor needs: changed paths/artifacts/findings, verification status, remaining blockers, and the next command/action.

Guardrail: Prefer precise source evidence over guesses.

## Default loop

```
search → investigate → refs / impact / trace / impls → show / outline → targeted reads
```

1. **Find it** — `ct source search <query>`; add `--mode text`, `--mode path`, or `--mode structural` as needed.
2. **Understand it** — `ct source investigate <symbol>` for kind-adaptive context.
3. **Trace flow** — `ct source refs`, `ct source impact`, `ct source trace`, or `ct source impls`.
4. **Read** — use `ct source show <symbol>` for symbol metadata, `ct source outline <file>` before opening large files, then the read tool for source lines.

## Goal → command

| I want to…                               | Command                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| Find a symbol                            | `ct source search <q>`                                                 |
| Find text                                | `ct source search --mode text <q>`                                     |
| Find paths                               | `ct source search --mode path <q>`                                     |
| Find structural matches                  | `ct source search --mode structural --lang <lang> --pattern <pattern>` |
| Get kind-appropriate context             | `ct source investigate <symbol>`                                       |
| Resolve symbol metadata                  | `ct source show <symbol>`                                              |
| List symbols in a file                   | `ct source outline <file>`                                             |
| Find direct references                   | `ct source refs <symbol>`                                              |
| See who depends on a symbol transitively | `ct source impact <symbol>`                                            |
| See what a symbol calls                  | `ct source trace <symbol>`                                             |
| Find implementations/conformances        | `ct source impls <symbol>`                                             |
| Scope a git diff to a symbol             | `ct source diff <symbol> [base]`                                       |

Every command supports `--json`.

## Examples

```bash
ct source search OpenStore
ct source search parse --kind function --lang go
ct source search --mode text "TODO"
ct source search Handler --path 'internal/**' --exclude '**/*_test.go'
ct source investigate OpenStore
ct source show internal/index/store.go:OpenStore
ct source outline internal/index/store.go --signatures
ct source refs ParseFile --file internal/
ct source impact handleRegister --depth 3
ct source trace handleRegister --kinds call,use
ct source impls Handler
ct source diff ParseFile main --stat
```

## Don't

- Don't grep or broad-read for a symbol that source navigation can resolve directly.
- Don't read a large file without `outline` first.
- Don't retry searches with synonyms more than twice; pivot to seam names such as registry, runtime, policy, session, store, descriptor, provider, or handler.
- Don't paginate through graph output; narrow with `--limit`, `--path`, or `--file`.

## Constraints

- `refs`, `impact`, and `trace` are best-effort code-index navigation, not full semantic analysis.
- Cross-package name collisions can inflate graph results; narrow by path or file.
- Structural search delegates to the configured AST backend and requires `--lang`.

## Outcome

Start with source navigation. Trust the first good rank. Read last.
