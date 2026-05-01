set shell := ["sh", "-eu", "-c"]

repo := justfile_directory()
home := env("HOME")

default:
    @just --list

check:
    cd "{{ repo }}" && \
    cargo fmt --all -- --check && \
    cargo clippy --all -- -D warnings && \
    cargo check --all-targets && \
    bun run check

test:
    cd "{{ repo }}" && \
    cargo nextest run && \
    bun run test

build:
    cd "{{ repo }}" && cargo build --release -p ct

render-agents:
    cd "{{ repo }}" && cargo xtask render-agents

link-dry-run: render-agents
    cd "{{ repo }}" && cargo xtask link-dry-run

link: render-agents codex-plugins-install
    cd "{{ repo }}" && cargo xtask link

unlink:
    cd "{{ repo }}" && cargo xtask unlink || true

restow: render-agents codex-plugins-install
    cd "{{ repo }}" && cargo xtask link

doctor:
    cd "{{ repo }}" && cargo xtask doctor

validate: render-agents
    cd "{{ repo }}" && cargo xtask validate

setup: node-deps-install pi-node-modules-link doctor link worktrunk-install claude-plugins-install install validate

node-deps-install:
    cd "{{ repo }}" && bun install

pi-node-modules-link:
    ln -sfn ../../node_modules "{{ repo }}/pi/agent/node_modules"

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

install:
    curl -L https://dmtrkovalenko.dev/install-fff-mcp.sh | bash
    cargo install --path "{{ repo }}/crates/ct"
    claude mcp remove -s user fff 2>/dev/null || true
    claude mcp remove -s user vault 2>/dev/null || true
    claude mcp remove -s user source 2>/dev/null || true
    claude mcp remove -s user apply-patch 2>/dev/null || true
    claude mcp remove -s user sym 2>/dev/null || true
    claude mcp remove -s user lens 2>/dev/null || true
    claude mcp add -s user fff -- $HOME/.local/bin/fff-mcp

completions:
    mkdir -p "{{ home }}/.config/fish/completions"
    ct shell completion fish > "{{ home }}/.config/fish/completions/ct.fish"
