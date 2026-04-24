# agents

Central agent configuration hub for Claude, Codex, OpenCode, and Pi.

The repo is shared-by-default:

- `AGENTS.template.md` is the hand-edited instruction source.
- `GLOBAL_AGENTS.md` is generated from the template plus `rules/*.md`.
- `AGENTS.md` is repo-local guidance for maintaining this hub.
- `rules/` is linked into `~/.agents/rules` so generated instructions can use a stable path.
- `skills/` is linked into both `~/.agents/skills` and `~/.claude/skills`.
- `hooks/` contains shared hook scripts; Claude and Codex config files only register them.
- `plugins/` contains shared plugin sources. Tool-specific folders should link to these instead of duplicating plugin content.
- `tools/ct/` contains the migrated `ct` Rust package.

Use `just link-dry-run` before linking. `just setup` converges the local machine state idempotently.
