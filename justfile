set shell := ["sh", "-eu", "-c"]

repo := justfile_directory()
home := env("HOME")

default:
    @just --list

render-agents:
    python3 "{{ repo }}/scripts/render_agents.py"

link-dry-run: render-agents
    python3 "{{ repo }}/scripts/stow_targets.py" dry-run

link: render-agents codex-plugins-install
    python3 "{{ repo }}/scripts/stow_targets.py" link

unlink:
    python3 "{{ repo }}/scripts/stow_targets.py" unlink || true

restow: render-agents codex-plugins-install
    python3 "{{ repo }}/scripts/stow_targets.py" link

doctor:
    command -v stow
    command -v just
    command -v cargo
    command -v codex
    command -v claude
    command -v opencode
    command -v ct || true
    test -d "{{ home }}/.pi" || echo "warning: {{ home }}/.pi does not exist yet"

validate: render-agents
    python3 "{{ repo }}/scripts/validate.py"

setup: doctor link claude-plugins-install ct-install validate

codex-plugins-install:
    python3 "{{ repo }}/scripts/install_codex_plugins.py"

claude-plugins-install:
    claude plugin marketplace update local
    claude plugin uninstall gt@local || true
    claude plugin install -s user gt@local

ct-build:
    cargo build --release --manifest-path="{{ repo }}/tools/ct/Cargo.toml"

ct-test:
    cargo test --manifest-path="{{ repo }}/tools/ct/Cargo.toml"

ct-install: ct-test
    cargo install --path "{{ repo }}/tools/ct"
    claude mcp remove -s user ct 2>/dev/null || true
    claude mcp remove -s user blueprint 2>/dev/null || true
    claude mcp remove -s user apply-patch 2>/dev/null || true
    claude mcp add -s user blueprint ct mcp blueprint
    claude mcp add -s user apply-patch ct mcp apply-patch

ct-completions:
    mkdir -p "{{ home }}/.config/fish/completions"
    ct tool completion fish > "{{ home }}/.config/fish/completions/ct.fish"
