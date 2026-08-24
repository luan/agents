# Upstream

The provider transport and Responses conversion are focused ports from:

```text
/tmp/howaboua-pi-stuff/packages/pi-codex-conversion/
```

Source revision:

```text
4b4e42f7659e42854ec81cb502bf69a48422d9eb
```

Imported areas:

- `src/providers/constrained-sampling.ts`
- `src/providers/openai-codex/`
- `src/providers/openai-responses/`
- `src/adapter/compaction/remote-v2-client.ts`
- `src/adapter/compaction/remote-v2-history.ts`
- `src/adapter/compaction/request-shrink.ts`
- `src/adapter/compaction/types.ts`
- `src/diagnostics/lazy.ts`
- `src/diagnostics/logger.ts`
- `src/diagnostics/runtime.ts`

The OAuth flow is a local port of the Pi 0.84.2 OpenAI Codex OAuth behavior.

The model catalogue started from the Pi 0.84.2 catalogue.

The local package now owns both implementations.

The remote-v2 protocol, feature header, request shrinking, encrypted output validation, retained user-message window, strategy, and details format come from the upstream compaction sources listed above.

The local package owns the remote-v2 implementation and its provider runtime contract.

The local compaction extension owns the `session_before_compact` and `before_provider_request` hook boundary.

The historical hook implementation, settings loader, debug logger, artifact writer, HTTP client, and strategy are not present.

Remote-v2 compaction supports only `openai-codex` with `openai-codex-responses`.

Responses Lite support is fully removed.

Hook-boundary tests cover remote replay after resume and preservation of the prior encrypted checkpoint during Pi fallback.

The diagnostics port keeps the upstream metadata-only event contract, cache status behavior, three-second cache-miss hold, safe per-session logging, and failure isolation.

The local diagnostics controller owns its subscription to the provider runtime.

The local diagnostics setting is `cacheDiagnostics` in the shared
`~/.pi/agent/xsettings.toml`. Without the settings host, the package uses its
compiled default.

The local diagnostics log directory is `~/.pi/agent/logs/codex-native/`.

The upstream settings UI and the complete `pi-codex-conversion.json`
configuration system are not present. The local package contributes its
supported settings to the repository's generic `pi-xsettings` UI.

The local port removes Code Mode, Responses Lite, image generation, Codex Apps,
MCP, custom prompts, custom rendering, and the upstream settings UI.

The local package does not use Pi's built-in Codex provider, model catalogue, or OAuth implementation.

The package is not the complete `@howaboua/pi-codex-conversion` package.
