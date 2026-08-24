# Upstream

Ported from `IgorWarzocha/howaboua-pi-stuff` at commit
`e12067caadc38da4e785d0300202aac233ae3b2f`:

- `packages/pi-codex-conversion/src/tools/view-image/tool.ts`
- `packages/pi-codex-conversion/src/tools/view-image/output.ts`
- `packages/pi-codex-conversion/src/tools/view-image/rust/main.rs`

This repository splits the tool into an independently installable Pi package
and a root Cargo workspace crate. The upstream Codex-backed text-only-model
description fallback is omitted. Native attachments work with every provider
whose Pi model declares image input; unsupported models fail before reading the
file.
