# Upstream

- Repository: `openai/codex`
- Codex release: `rust-v0.145.0`
- Codex commit: `25af12f7e61572b0bc18ddb1008be543b91519b0`
- Port source: `IgorWarzocha/howaboua-pi-stuff`
- Port commit: `4b4e42f7659e42854ec81cb502bf69a48422d9eb`
- Source boundary: `packages/pi-codex-conversion/code-mode/vendor/code-mode-src/crates/code-mode`

## Owned changes

- The crate uses the local `code-mode-protocol` crate.
- The unused remote process client is omitted.
- The crate keeps the restricted in-process V8 session used by the stdio host.
