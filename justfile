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

setup: doctor link worktrunk-install claude-plugins-install install validate

worktrunk-install:
    # The `wt` binary backs the worktrunk claude plugin. `cargo install`
    # rebuilds even when the version is unchanged, so skip when `wt` is
    # already on PATH. To upgrade, run `cargo install worktrunk --force`.
    @command -v wt >/dev/null 2>&1 || cargo install worktrunk --locked

codex-plugins-install:
    cd "{{ repo }}" && cargo xtask codex-plugins-install

claude-plugins-install:
    # worktrunk: marketplace is auto-registered from claude/settings.json's
    # extraKnownMarketplaces once `link` ran; settings.json also enables
    # worktrunk@worktrunk, so claude breaks on startup if it isn't installed.
    # `claude plugin install` is idempotent (no-op when already installed).
    claude plugin install worktrunk@worktrunk
    # Keep the local `agents` marketplace disabled until its schema is updated.

pi-extensions-install:
    cd "{{ repo }}/pi/agent/extensions" && npm install --omit=dev

build:
    cd "{{ repo }}" && cargo build --release -p ct

test:
    cd "{{ repo }}" && cargo nextest run

install:
    cargo install --path "{{ repo }}/crates/ct"
    claude mcp remove -s user vault 2>/dev/null || true
    claude mcp remove -s user apply-patch 2>/dev/null || true
    claude mcp remove -s user sym 2>/dev/null || true
    claude mcp remove -s user lens 2>/dev/null || true
    claude mcp add -s user vault ct mcp vault
    claude mcp add -s user apply-patch ct mcp apply-patch
    claude mcp add -s user sym ct mcp sym
    claude mcp add -s user lens ct mcp lens

completions:
    mkdir -p "{{ home }}/.config/fish/completions"
    ct tool completion fish > "{{ home }}/.config/fish/completions/ct.fish"
