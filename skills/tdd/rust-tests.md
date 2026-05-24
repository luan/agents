# Rust Tests

Use this reference when writing or reviewing Rust tests under the TDD skill. The general rule from [tests.md](tests.md) still applies: test behavior through the best available interface, not incidental implementation shape.

## Placement Ladder

Choose the highest rung that keeps behavior clear:

1. **Integration tests** in `tests/*.rs` for public crate contracts, cross-module workflows, and refactor-resistant coverage.
2. **CLI tests** when the command is the interface. Use `assert_cmd` for args, exit codes, stdout, and stderr. Keep `main` thin when possible; test non-CLI behavior through library seams.
3. **Module tests** with `#[cfg(test)] mod tests` for focused parsing, validation, state transitions, known-answer algorithms, and error paths. Private helper tests are allowed when they make failures clearer than heavy public setup would.
4. **Split large unit-test modules** when tests dominate the production file:

   ```rust
   #[cfg(test)]
   mod foo_tests;
   ```

5. **Doctests** only when the example is part of the public API contract. Avoid doctests for bulky setup or internal behavior.

Pressure signals:

- Many private-helper tests usually mean the module is too large or the seam is unclear.
- Shared integration helpers should stay small; fixture frameworks often hide the behavior under test.

## Runner and Dependencies

Prefer nextest when available; use `cargo test` when nextest is absent or when running doctests:

```sh
cargo nextest run test_name
cargo test test_name
cargo test --test integration_file_name
cargo test --doc
```

Add dev-dependencies when they materially improve coverage or readability and match the project's dependency style. Prefer existing dependencies first.

```sh
cargo add --dev pretty_assertions
cargo add --dev rstest
cargo add --dev proptest
```

## Standard Tools

- **pretty_assertions**: use for clearer diffs. Import locally unless the project already has a test prelude: `use pretty_assertions::assert_eq;`
- **rstest**: use when named cases or fixtures make coverage easier to read: validation tables, repeated setup with clear fixture names, or combinations where each case needs a readable name. Avoid fixture pyramids; inline setup when fixtures hide the behavior.
- **proptest**: use when a property describes behavior better than enumerating examples. Property-first TDD is acceptable when the property clarifies the contract.

Good properties for `proptest`:

- parse/format round trips
- idempotent normalization
- ordering or monotonicity guarantees
- generated valid inputs are accepted
- invalid input classes are rejected
- arbitrary input does not panic

If generated failures are noisy, shrink the failure into a focused regression example or narrow the strategy before continuing.

## Boundary and Optional Tools

- `assert_cmd`: standard for CLI behavior.
- `tempfile`: default for simple isolated files or directories.
- `assert_fs`: use when filesystem fixtures/assertions improve clarity.
- `insta`: use only when snapshots already exist or the user explicitly asks for snapshot/golden-output testing.

Do not use boundary tools to verify implementation storage details. Use them when the boundary is part of the public contract.

## Escalation Tools

These are not normal TDD tools:

- `cargo-fuzz`: parsers, unsafe boundaries, or input-heavy code.
- `cargo-mutants`: audit whether tests catch meaningful code changes.

## Bad Smells

- Unit tests dwarf the module they test.
- Tests assert type-system facts, getters, setters, or constants.
- Assertions duplicate the production algorithm instead of checking a known-answer or property.
- Integration tests reach into internals to verify behavior with a public API.
- Property tests generate broad input without a named invariant.
- Fixtures make the test shorter but the behavior harder to see.
