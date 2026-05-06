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
    bun run typecheck && \
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

setup: node-deps-install pi-node-modules-link doctor link worktrunk-install install validate

node-deps-install:
    cd "{{ repo }}" && bun install

pi-node-modules-link:
    ln -sfn ../../node_modules "{{ repo }}/pi/agent/node_modules"

worktrunk-install:
    # The `wt` binary backs the worktrunk claude plugin. `cargo install`
    # rebuilds even when the version is unchanged, so skip when `wt` is
    # already on PATH. To upgrade, run `cargo install worktrunk --force`.
    @command -v wt >/dev/null 2>&1 || cargo bininstall worktrunk --locked

codex-plugins-install:
    cd "{{ repo }}" && cargo xtask codex-plugins-install

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
