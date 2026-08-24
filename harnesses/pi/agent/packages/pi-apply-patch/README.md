# pi-apply-patch

`pi-apply-patch` adds an `apply_patch` tool that applies Codex-style patches
through the repository's Rust implementation. The same operation works when
called directly by Pi or from Code Mode.

## Install

Build the native tool from the repository root, then install the Pi package:

```sh
cargo build --release -p apply-patch
pi install ./harnesses/pi/agent/packages/pi-apply-patch
```

The package normally runs `target/release/apply_patch`. Set
`PI_APPLY_PATCH_BIN` to an executable binary elsewhere when developing or
testing.

## Direct and Code Mode calls

`pi-apply-patch` registers `apply_patch` as a normal direct Pi tool and also
registers a Code Mode execution adapter. `pi-code-mode` alone decides which
one the model sees when Code Mode and `exec` are active:

- If `apply_patch` is not selected under exec, the model calls the active
  direct tool with `{ "input": "...patch text..." }`.
- If it is selected in `pi-code-mode.tools`, it disappears from the direct
  tool list and becomes `tools.apply_patch("...patch text...")` inside `exec`.

The adapter forwards execution and reuses this package's semantic diff
presentation inside Code Mode. This package does not change the tool hierarchy,
read Code Mode settings, or create another nested-tool system.

## Patch format

Every input starts and ends with the patch markers. Use one action header per
file:

```text
*** Begin Patch
*** Add File: notes/today.txt
+A new file.
*** Update File: src/main.ts
@@
-old line
+new line
*** Delete File: obsolete.txt
*** End Patch
```

Supported actions are `Add File`, `Update File`, `Delete File`, and `Move to`.
Put `*** Move to: ...` immediately after an `*** Update File: ...` header.
Order multiple hunks for one file from top to bottom. Context and indentation
are literal text.

Paths are resolved relative to the Pi session cwd. Absolute paths are passed
through as absolute paths. A leading `@` is accepted for compatibility with
Pi path arguments.

## Execution and results

The Rust binary owns parsing, matching, filesystem mutations, and partial
failure tracking. The TypeScript package owns Pi registration, argument
normalization, per-file mutation queues, process control, and result shaping.

The tool serializes mutations touching the same path, including the
read-modify-write window. A successful result reports changed, created,
deleted, and moved files, fuzz, and the native committed unified diff. The
input patch is only a queued/running preview; completed presentation uses the
native diff so line ranges describe the files that were actually written. If
an early action succeeds and a later action fails, the tool returns a
`partial_failure` result that lists and renders only the committed prefix.
Read failed files before retrying, and do not reapply successful actions.
Direct Pi calls are marked as errors; a Code Mode call reports the partial
failure through the nested execution result.

The direct tool uses native freeform grammar when the provider supports it.
Other providers receive the ordinary `{ input: string }` function schema. In
Code Mode, the adapter always receives the raw patch string.

## API

The package's default export is the Pi extension. The supported exports from
`src/index.ts` include:

- `createApplyPatchTool()` and `registerApplyPatchTool()` for Pi registration.
- `executePatchWithRust({ cwd, patchText, signal?, binary? })` for the native
  execution boundary.
- `resolveApplyPatchBinary()` for the default/override binary lookup.
- `ApplyPatchToolDetails`, `ApplyPatchOperation`, and related result types.

The result details are versioned and JSON-serializable. The stable fields are
the operation list, affected paths, per-file statuses, counts, progress,
timing, native result, and partial-failure information.

## Architecture map

| Role | Owner |
| --- | --- |
| Tool definition | `src/tools/apply-patch/definition.ts` |
| Execution owner | `src/executor.ts` and the Rust `apply-patch` crate |
| State owner | The native process owns one patch execution; the package keeps no session state |
| Native boundary | `src/executor.ts` spawns `target/release/apply_patch` |
| Hierarchy bridge | `src/code-mode-adapter.ts` via `pi-code-mode/sdk` |
| Presentation owner | `src/tools/apply-patch/presentation.ts` previews input while queued/running and renders the native committed diff when complete |
| Public capabilities | Direct `apply_patch`, Code Mode adapter, executor, and result types |

## Troubleshooting

- **Binary not found:** run `cargo build --release -p apply-patch`, or set
  `PI_APPLY_PATCH_BIN` to an executable file.
- **The tool stays direct:** select `apply_patch` in Code Mode's `Tools under
  exec` setting and restart the session. Only Code Mode owns placement.
- **The tool is missing entirely:** check Pi's active tool selection. A strict
  `--tools` list must include `apply_patch` or `exec`, depending on which path
  you want to use.
- **A patch partially failed:** preserve the successful edits, read each
  failed target again, and retry only the failed actions.
- **A patch is rejected:** check the begin/end markers, action headers, exact
  context lines, and the required `+` prefix for added-file content.

## Validation

```sh
cargo test -p apply-patch
bun run --cwd=harnesses/pi/agent/packages/pi-apply-patch typecheck
bun test --cwd=harnesses/pi/agent/packages/pi-apply-patch
```

From the repository root, `just check` runs the aggregate TypeScript, Rust,
and harness checks.
