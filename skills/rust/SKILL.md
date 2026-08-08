---
name: rust
description: Rust validation, warning, dead-code, import, and Cargo dependency rules. Use when changing or reviewing Rust code or Cargo dependencies.
---

# Rust

## Validation

After every implementation, run this validation chain:

1. `cargo fmt`
2. `cargo clippy -- -W clippy::all`
3. `cargo nextest run` when nextest is available, or `cargo test` otherwise
4. `cargo test --doc` when the crate has doctests, which nextest does not run
5. `cargo build`

Reach zero warnings and zero failures before presenting code to the user.

Write constructs that compile clean.
An unused variable, dead code, or an empty enum that makes a type uninhabited produces a warning.
Prefer the simpler construct that stays quiet over a complex construct that needs silencing.
Add `#[allow(...)]` only when the user directly instructs it.

## Tests

Place each test at the highest stable seam that reaches the behavior: an integration test under `tests/*.rs` for public crate behavior, `assert_cmd` at the executable boundary for CLI contracts, a `#[cfg(test)]` module for internals, and a doctest where the example is the documentation.

Reach for the tool that matches the shape:

| Need | Crate |
|---|---|
| Readable assertion diffs | `pretty_assertions` |
| Named cases and fixtures | `rstest` |
| Properties over generated input | `proptest` |
| CLI contracts | `assert_cmd` |
| Filesystem contracts | `tempfile`, `assert_fs` |
| Snapshots, where one already exists or the user asks | `insta` |

Check `Cargo.toml` dev-dependencies before adding any of them. For a wide pass over an existing suite, use `$improve-rust-tests`.

## Dead code

Remove dead code immediately.
Mark test-only items with `#[cfg(test)]`.

## Imports

Keep every `use` at the top of the file.

## Cargo.toml

- Use the latest stable versions unless compatibility requires otherwise.
- Use the highest unambiguous version: `^3`, not `^3.0`.
- Share dependencies across the workspace.
- Keep the dependency list flat. Add comments or grouping only when they earn their place.
- Keep custom features few.
