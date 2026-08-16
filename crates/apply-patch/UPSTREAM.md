# Upstream

This crate is a fork, not a vendored copy. Update it by hand.

| Source | Upstream path | Pinned revision |
| --- | --- | --- |
| `openai/codex` | `codex-rs/apply-patch` | `b545c94041017d000e2c8b2f6272705d21b85dfb` |
| `openai/codex` | `codex-rs/utils/absolute-path`, `codex-rs/utils/path-uri` | `8707a35113501a9988f06162ca5c2b27d4f90a58` |

The path-tools pin was previously recorded as `d36a3ead3c896d0552207763ef483262bce9ac73`. That was
wrong: `codex-rs/utils/path-uri` did not exist upstream until `ffec7c0933`, six days later.
Content-diffing every upstream revision against the local files matches `8707a35113` exactly, so
that is the real pin.

## Crate layout

Upstream ships four crates. This fork holds one.

| Upstream crate | Here |
| --- | --- |
| `codex-apply-patch` | `src/lib.rs`, `src/parser.rs`, `src/seek_sequence.rs`, `src/streaming_parser.rs`, `src/invocation.rs`, `src/standalone_executable.rs`, `src/main.rs` |
| `codex-utils-absolute-path` | `src/absolute_path.rs`, `src/absolute_path/` |
| `codex-utils-path-uri` | `src/path_uri.rs`, `src/path_uri/` |
| `codex-exec-server` | `src/fs.rs` (rewritten, see below) |

## Local divergence

- `src/standalone_executable.rs` is a Pi-specific rewrite. It reads `PI_APPLY_PATCH_INPUT_FILE` and
  emits `PathUri`-based JSON. Every other file from the apply-patch pin is byte-identical to it.
- **`src/fs.rs` is plain synchronous functions, and the crate has no async at all.** This is the
  widest divergence from upstream, and it touches nearly every function in `lib.rs` and
  `invocation.rs`. Expect a conflict here on any future sync.

  Upstream routes filesystem access through an `ExecutorFileSystem` trait behind
  `Arc<dyn ...>`, threads a `fs: &dyn ExecutorFileSystem` and a
  `sandbox: Option<&FileSystemSandboxContext>` pair through about 28 signatures, and marks every
  method `async fn`. Here that trait had exactly one implementor, every body called synchronous
  `std::fs`, no await point did real work, and the sandbox argument was `None` at every call site
  while every implementation returned `io::ErrorKind::Unsupported` when it was `Some`.

  So: the trait, `LOCAL_FS`, `FileSystemSandboxContext`, both threaded parameters, and every
  `async`/`.await` are gone. `FileMetadata` keeps only `is_directory`, `is_file`, and `is_symlink`;
  `size`, `created_at_ms`, and `modified_at_ms` had no reader. The `tokio` and `async-trait`
  dependencies are gone with them, and `standalone_executable.rs` no longer builds a runtime.
  Net 302 lines removed, 160 tests still passing.

  To take an upstream change into `lib.rs` or `invocation.rs`, drop the `fs` and `sandbox`
  arguments from the incoming signature, call `crate::fs::<op>(...)` directly, and delete the
  `.await`.
- `src/path_uri.rs` and `src/path_uri/api_path_string.rs` use stable `chunks_exact(2)` where
  upstream uses nightly-only `as_chunks::<2>()`.
- `schemars` and `ts_rs` derives are removed. They emit JSON-schema and TypeScript bindings for
  Codex's own IPC and nothing in Pi reads them. This also resolved a version split: upstream
  `codex-utils-absolute-path` used `schemars = "1"` while `codex-utils-path-uri` used
  `schemars = "0.8.22"`, which one crate cannot hold. Removed with the derives: `JsonSchema`, `TS`,
  the `#[ts(...)]` attributes, and the manual `impl JsonSchema` blocks for `PathUri` and
  `LegacyAppPathString`.
- `#[path = "..."]` module attributes are dropped in favour of the conventional layout.

## Drift as of this pin

Four upstream commits touch `codex-rs/apply-patch` after `b545c94`:

- `a1c88e865d` reject duplicate resolved paths (#37867) — **applied here**.
- `511262b984` delegate remote process sandboxing to the executor (#37480) — **not applied**. Only
  two `pub use` re-exports (`MaybeApplyPatch`, `maybe_parse_apply_patch`) reach this path, and they
  exist for `codex-core`, which Pi does not have. Unused public API, so it stays out.
- `21aa552e87` + `c9c6c0daa9` line-ending preservation (#37757, #37758) — **not applied**. A real
  feature: a 572-line `lib.rs` rewrite plus new `file_update.rs` and `text_file.rs`. Take it
  deliberately, not as a drive-by backport.

Three upstream commits touch the path tools after `8707a35113`, none of them isolated bugfixes:

- `a01a2d9146` preserve executor paths in read command actions (#36223).
- `4cb8676d3a` make Windows path URI comparisons ASCII-case-insensitive (#37129) — changes `Eq`,
  `Hash`, and `starts_with` semantics for Windows paths.
- `f4936d7aba` support execution-host context when resolving cloud config (#38086) — additive.

## Updating

Diff the upstream path at the pin against upstream HEAD, then apply the parts that matter by hand.
Re-strip the `schemars` and `ts_rs` derives on anything new, and keep `chunks_exact`. Move the pin
in this file and in `NOTICE` when done.
