# Upstream

- Repository: `openai/codex`
- Codex release: `rust-v0.145.0`
- Codex commit: `25af12f7e61572b0bc18ddb1008be543b91519b0`
- Port source: `IgorWarzocha/howaboua-pi-stuff`
- Port commit: `4b4e42f7659e42854ec81cb502bf69a48422d9eb`
- Source boundary: `packages/pi-codex-conversion/code-mode/vendor/code-mode-src/crates/code-mode-protocol`

## Owned changes

- The crate uses its local `ToolName` type.
- The crate has no Codex workspace dependency.
- The wire protocol stays compatible with the standalone stdio host.
