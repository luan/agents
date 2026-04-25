set shell := ["sh", "-eu", "-c"]

repo := justfile_directory()
home := env("HOME")

default:
    @just --list

render-agents:
    cd "{{ repo }}" && cargo xtask render-agents

link-dry-run: render-agents
    cd "{{ repo }}" && cargo xtask link-dry-run

link: render-agents codex-plugins-install pi-extensions-install
    cd "{{ repo }}" && cargo xtask link

unlink:
    cd "{{ repo }}" && cargo xtask unlink || true

restow: render-agents codex-plugins-install pi-extensions-install
    cd "{{ repo }}" && cargo xtask link

doctor:
    cd "{{ repo }}" && cargo xtask doctor

validate: render-agents
    cd "{{ repo }}" && cargo xtask validate

setup: doctor link claude-plugins-install ct-install validate

codex-plugins-install:
    cd "{{ repo }}" && cargo xtask codex-plugins-install

claude-plugins-install:
    claude plugin marketplace update local
    claude plugin uninstall gt@local || true
    claude plugin install -s user gt@local

pi-extensions-install:
    cd "{{ repo }}/pi/agent/extensions" && npm install --omit=dev

ct-build:
    cd "{{ repo }}" && cargo build --release -p ct

ct-test:
    cd "{{ repo }}" && cargo test -p ct

ct-install: ct-test
    cargo install --path "{{ repo }}/crates/ct"
    claude mcp remove -s user ct 2>/dev/null || true
    claude mcp remove -s user blueprint 2>/dev/null || true
    claude mcp remove -s user vault 2>/dev/null || true
    claude mcp remove -s user apply-patch 2>/dev/null || true
    claude mcp remove -s user sym 2>/dev/null || true
    claude mcp add -s user vault ct mcp vault
    claude mcp add -s user apply-patch ct mcp apply-patch
    claude mcp add -s user sym ct mcp sym

ct-completions:
    mkdir -p "{{ home }}/.config/fish/completions"
    ct tool completion fish > "{{ home }}/.config/fish/completions/ct.fish"
