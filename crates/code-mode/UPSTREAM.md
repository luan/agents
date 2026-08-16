# Upstream

These three crates — `code-mode-protocol`, `code-mode`, `code-mode-host` — are one fork, not a
vendored copy. Update them by hand.

| Source | Pinned revision |
| --- | --- |
| `openai/codex` code-mode | `25af12f7e61572b0bc18ddb1008be543b91519b0` |

## Crate layout

Upstream ships four crates. This fork holds three.

| Upstream crate | Here |
| --- | --- |
| `codex-protocol` | folded into `crates/code-mode-protocol/src/tool_name.rs`; it held only `ToolName` |
| `codex-code-mode-protocol` | `crates/code-mode-protocol` |
| `codex-code-mode` | `crates/code-mode` |
| `codex-code-mode-host` | `crates/code-mode-host` (binary `codex-code-mode-host`) |

## Local divergence

- `code-mode/src/session_runtime/mod.rs` uses `try_update` where upstream uses `fetch_update` on the
  cell-id atomic. Same semantics.
- `code-mode-host/tests/stdio.rs` resolves the binary through `env!("CARGO_BIN_EXE_...")` instead of
  the `codex-utils-cargo-bin` crate, which this fork does not carry.
- `code-mode/src/session_runtime/tests.rs` uses `#[allow(clippy::await_holding_invalid_type)]` rather
  than `#[expect]`. That lint only fires with an `await-holding-invalid-types` clippy.toml, which
  this workspace does not have, so `expect` was permanently unfulfilled.
- Six panic-probe tests carry `#[ignore = "panic probe aborts the v8-linked test binary"]`. They
  panic on purpose, and unwinding out of the panic aborts the v8-linked test binary with
  `fatal runtime error: failed to initiate panic, error 5`. Before the workspace move these tests
  never ran at all: the old recipe ran only `cargo test -p codex-code-mode-host`, and skipped two of
  them explicitly. The probes are:
  - `code-mode`: `cell_actor::callbacks::tests::{tool_callback_panic_rejects_the_js_promise_and_reports_failure, notification_callback_panic_reports_failure, callback_wrapper_join_error_reports_failure}`
  - `code-mode`: `remote_session::connection::driver::tests::delegate_task_panic_becomes_tool_error_without_killing_connection`
  - `code-mode`: `runtime::tests::{runtime_thread_panic_before_initialization_is_reported_directly, runtime_thread_panic_is_forwarded_without_owner_supervision}`
  - `code-mode`: `session_runtime::tests::reports_cell_actor_panics_to_the_owner`
  - `code-mode-host`: `tests::{request_task_panic_disconnects_host, cell_forwarding_panic_disconnects_host}`

## Drift as of this pin: re-vendor, do not cherry-pick

Upstream is 31 commits ahead across these paths, and the range is one continuous architecture
migration. Upstream **deleted the in-process V8 runtime this fork is built on** — roughly 7000 lines
across `cell_actor/`, `runtime/`, `service*.rs`, `session_runtime/`, and `v8_init.rs` — and replaced
it with a gRPC-only remote-host session model (`grpc_session/`, `grpc_transport.rs`,
`code-mode-host/src/grpc/`, roughly 5000 lines).

Waypoints: `97576b1794` run code mode exclusively through the standalone host (#36217),
`61a3dd4387` implement the gRPC code-mode host service (#37530), `1e557a554e` add gRPC-backed
sessions (#38041), `bde723ae7d` reconnect after host restarts (#38257).

There is nothing to cherry-pick. Every post-pin bugfix patches the gRPC transport, which does not
exist here, and no single commit compiles against this snapshot. Treat any future sync as a decision
to adopt the whole rewrite.

The one exception is `a186f5484d` resolve local JSON Schema refs in Code Mode types (#38664), which
lands in `code-mode-protocol` and may port independently. It is not applied here.
