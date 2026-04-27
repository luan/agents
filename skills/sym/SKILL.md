---
name: sym
description: "Canonical code navigator. Default to the source MCP tools (`mcp__source__search`, `mcp__source__show`, `mcp__source__outline`, `mcp__source__refs`, `mcp__source__impact`, `mcp__source__trace`, `mcp__source__impls`, `mcp__source__investigate`, `mcp__source__diff`); `ct source` is the CLI fallback for shell pipelines. Use before grep/find or broad file reads when exploring code, locating symbols, tracing callers/callees, finding implementations, or scoping a diff to a symbol."
---

# source — code navigation

**Default path:** use the source MCP tools when available. They return structured data and avoid shell quoting. Tool names are short within the `source` MCP server: `search`, `show`, `outline`, `refs`, `impact`, `trace`, `impls`, `investigate`, and `diff`.

**CLI fallback:** use `ct source <cmd>` when MCP is unavailable or when a shell pipeline is useful.

## Default loop

```
search → investigate → refs / impact / trace / impls → show / outline → targeted reads
```

1. **Find it** — `ct source search <query>`; add `--mode text`, `--mode path`, or `--mode structural` as needed.
2. **Understand it** — `ct source investigate <symbol>` for kind-adaptive context.
3. **Trace flow** — `ct source refs`, `ct source impact`, `ct source trace`, or `ct source impls`.
4. **Read** — `ct source show <symbol|file[:L1-L2]>` or `ct source outline <file>` before opening large files.

## Goal → command

| I want to… | Command |
|---|---|
| Find a symbol | `ct source search <q>` |
| Find text | `ct source search --mode text <q>` |
| Find paths | `ct source search --mode path <q>` |
| Find structural matches | `ct source search --mode structural --lang <lang> --pattern <pattern>` |
| Get kind-appropriate context | `ct source investigate <symbol>` |
| Read source by symbol or range | `ct source show <symbol \| file[:L1-L2]>` |
| List symbols in a file | `ct source outline <file>` |
| Find direct references | `ct source refs <symbol>` |
| See who depends on a symbol transitively | `ct source impact <symbol>` |
| See what a symbol calls | `ct source trace <symbol>` |
| Find implementations/conformances | `ct source impls <symbol>` |
| Scope a git diff to a symbol | `ct source diff <symbol> [base]` |

Every command supports `--json`.

## Examples

```bash
ct source search OpenStore
ct source search parse --kind function --lang go
ct source search --mode text "TODO"
ct source search Handler --path 'internal/**' --exclude '**/*_test.go'
ct source investigate OpenStore
ct source show internal/index/store.go:80-120
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
