## Code

1. Keep TypeScript harness adapters thin. Put substantial native tooling in `crates/*` and build it from the root workspace.
2. Use `index.ts` only as an export surface. Do not put runtime logic, state, registration, or implementation code in it.
3. Do not use TypeScript `any`.
4. Do not use raw `unknown` as an internal domain type. An untyped external boundary may use a named `unknown` alias only with an adjacent `type-boundary:` comment that names the source and the immediate validator. Narrow it once, then use concrete types, generics, or a closed data type such as `JsonValue`.

## Pi extensions

1. Before changing Pi behavior, read `docs/pi-extension-architecture.md`, the affected package README, and the relevant installed Pi documentation and references.
2. Keep every Pi extension independently installable and loadable. Keep its runtime dependencies in its own package.
3. Use Pi public APIs first. When Pi lacks an API, use a versioned structural capability owned by the package that provides it. Consumers must tolerate its absence and must not depend on the provider package at runtime.
4. Treat `harnesses/pi/agent/SYSTEM.md` as user-owned provider instructions.  Keep provider-specific serialization in provider packages. Do not map developer messages to user messages.
5. Keep tool-specific model guidance with the tool metadata. Enforce safety and policy on every execution path, including both direct and nested paths.
6. Keep tool execution independent of TUI code. Shared UI libraries must not register tools, hooks, commands, shortcuts, or UI by themselves.
7. Register extension settings with the public, UI-free `pi-xsettings/sdk` entry point. Put defaults in the typed definitions, use the extension label as its subcategory, and use existing xsettings categories. An extension uses those compiled defaults when the xsettings host is absent.  Do not add a second per-extension settings file.  Describe structured values with xsettings-owned setting kinds such as the ordered list definition. Extensions provide data schemas, labels, defaults, options, and constraints; they must not register settings UI components.
8. Register custom actions through `pi-libactions/registry/v1`. Feature extensions do not call `pi.registerShortcut` or own default keys. The managed `keybindings.json` file owns custom bindings.
9. Style extension-owned UI with `tuiTheme(theme)` and semantic tokens from `pi-libtui`. Feature packages never call Pi's color methods or use Pi color token types directly, including when they render a Pi-owned surface; `pi-libtui` owns any native-token alias. Keep literal color SGR sequences and palette indices inside `pi-libtui` terminal compatibility code; feature UI uses generated tokens, swatches, and destination-aware contrast helpers.
10. In Pi feature packages, route every UI color through `pi-libtui`, including aliases for Pi-owned surfaces. Do not call Pi theme color methods or use Pi color token types directly. Reuse `pi-libtui` components for their matching interaction contracts instead of rebuilding selection, pointer, dialog, or field behavior in a feature extension.
11. Validate reusable TUI behavior through focused package tests and live Pi sessions in the affected extensions. Do not maintain a parallel showcase renderer that can diverge from Pi.

## Harness state and linking

1. Keep `~/.claude`, `~/.codex`, and `~/.pi` as real runtime directories. Do not replace a harness root with a symlink.
2. Use the root `managed.toml` to select repo-owned harness files and trees.
3. Manage Pi `agent/packages` as one tree. Exclude `node_modules` from tree linking.
4. Keep harness linking logic in the Rust `xtask`. Use `cargo xtask harness <setup|check|unlink>` for harness links.
5. Never manage Pi credentials, sessions, caches, model stores, or other generated runtime state. Keep generated state ignored and out of version control.
6. Keep `~/.pi/agent/settings.json` as an intentional mutable symlink to `harnesses/pi/agent/settings.json`. Pi may update the repo-owned settings file through that symlink.
7. Seed the real mutable `~/.codex/config.toml` from `harnesses/codex/config.toml.seed` only when the target does not exist.  Never overwrite an existing target.
8. Refuse setup when a managed link path contains a real file or a symlink to the wrong target.
9. Make `just unlink` remove only exact managed symlinks owned by this repository.

## Required validation

1. Run `bun run lint:pi` after changing Pi TypeScript. Resolve every violation; feature packages have no color-policy exemptions.
2. Run `just setup` after dependency or build changes.
3. Run `just check` before handoff.
4. Verify each changed Pi package with `just pi-install-check <relative path>`. This runs `pi install` against a temporary agent directory; validation must never modify the live `~/.pi/agent/settings.json` symlink.
5. Run TypeScript checks and tests for changed TypeScript packages. 
6. Run Rust formatting, workspace checks, tests, and Clippy for changed Rust tools.
