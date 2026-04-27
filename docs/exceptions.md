# Exceptions

Shared configuration is the default. Files in agent-specific folders are allowed only when the target tool requires a different schema, filename, or runtime registration mechanism.

- `claude/settings.json`: Claude-specific settings, hook registration, plugin marketplace configuration, and UI preferences.
- `codex/config.toml`: Codex-specific settings, MCP configuration, plugin settings, the `codex_hooks` feature flag, and Codex-managed absolute project trust entries.
- `codex/hooks.json`: Codex-specific hook registration format.
- `opencode/opencode.jsonc`, `opencode/dcp.jsonc`, `opencode/tui.json`: OpenCode-specific configuration schemas.
- `pi/`: Pi config root placement. Add Pi-specific files here only when their required filenames are known.
