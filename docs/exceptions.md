# Exceptions

Shared configuration is the default. Files in agent-specific folders are allowed only when the target tool requires a different schema, filename, or runtime registration mechanism.

- `claude/settings.json`: Claude-specific settings, plugin marketplace configuration, and UI preferences.
- `codex/config.toml`: Codex-specific settings, MCP configuration, plugin settings, and Codex-managed absolute project trust entries.
- `pi/`: Pi config root placement. Add Pi-specific files here only when their required filenames are known.
- `omp/agent/config.yml`: OMP-specific agent settings; only the config file is linked so runtime databases, logs, and caches stay under `~/.omp`.
