# Exceptions

Shared configuration is the default. Files in agent-specific folders are allowed only when the target tool requires a different schema, filename, or runtime registration mechanism.

- `claude/settings.json`: Claude-specific settings, hook registration, plugin marketplace configuration, and UI preferences.
- `codex/config.toml`: Codex-specific settings, MCP configuration, plugin settings, and the `codex_hooks` feature flag.
- `codex/hooks.json`: Codex-specific hook registration format.
- `bin/agents-hook`: Stable hook command wrapper. Configs should call this instead of checkout-specific paths.
- `bin/opencode`: OpenCode reads `OPENCODE_DISABLE_CLAUDE_CODE` before loading JSON config, so the launcher owns the process-start flag while `opencode/opencode.jsonc` owns OpenCode paths.
- `opencode/opencode.jsonc`, `opencode/dcp.jsonc`, `opencode/tui.json`: OpenCode-specific configuration schemas.
- `pi/`: Pi config root placement. Add Pi-specific files here only when their required filenames are known.
