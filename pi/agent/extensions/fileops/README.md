# fileops backend boundary

`fileops` owns the local file-operation workflow: `edit`, `read`, `search`,
`find`, `write`, hashline snapshots, grammar loading, and the copied OMP
hashline core.

The backend strategy is a narrow TypeScript adapter around the copied OMP core:

- the copied `hashline/` module stays runtime-agnostic;
- `CwdHashlineFilesystem` is the Pi-specific filesystem adapter;
- tool definitions translate Pi tool calls into the core interfaces.

The optional `apply_patch` mode uses copied OpenAI Codex Rust source under
`apply-patch/`. `just setup` and `just install` build that source locally.
The TypeScript adapter exchanges patch and JSON files with the executable.
This avoids platform binaries and runtime downloads.

## `read` is one parameter

`read` takes a path and nothing else. Line ranges, raw mode, and the merge
conflict index are selectors on the path (`src/a.ts:120-180`, `:raw`,
`:conflicts`), because three encodings of a line range meant the model picked
whichever one the last example used.

An unscoped read of parseable code answers with a structural summary —
declarations kept, bodies elided — and a footer naming the ranges to re-read
and tallying what the file declares. The outline is bounded in tokens, not
lines, and collapses to coarser tiers as the file grows: bodies, then whole
declarations, and past that only the ones the budget can afford, exported
first. `block-resolver.ts` builds it; `read-summary.test.ts` pins the invariant
that makes it safe, which is that the lines the summary displays are exactly
the lines a later hashline edit may anchor to.

## Explicit non-parity

The Pi adapter covers text-file workflow parity: `read`, `search`, `find`,
`write`, and `edit` over local filesystem paths, plus enough type routing that
an archive, a SQLite database, a PDF, or a binary answers with its shape rather
than its bytes (`read-routing.ts`, via `tar`/`unzip`/`sqlite3`/`pdftotext` when
those exist). OMP runtime features that depend on services Pi does not expose
here are not silently emulated: archive and SQLite *writes*, notebook
serialization, generated-file guards, and LSP formatting/diagnostics are
unsupported until a dedicated adapter exists.
