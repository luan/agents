# Upstream

- Source repository: `https://github.com/IgorWarzocha/howaboua-pi-stuff`
- Source commit: `5d88318e65368b8d118d6272d283bbd0031ddcca`
- Source package: `packages/pi-codex-conversion`
- Embedded Codex source: `openai/codex@b545c94041017d000e2c8b2f6272705d21b85dfb`
- Path module source: `openai/codex@8707a35113501a9988f06162ca5c2b27d4f90a58`

The patch engine preserves the upstream parser, matching, file mutation, and partial-failure semantics.

The local crate owns one flat module tree.

- `src/absolute_path*` and `src/path_uri*` replace upstream utility crates.
- Schema and TypeScript binding dependencies are removed.
- `src/fs.rs` replaces the upstream exec-server dependency with local host filesystem access.
- The command emits native file paths. It rejects non-file resource URIs.

The OpenAI sources use Apache-2.0. The howaboua adapter sources use MIT.
