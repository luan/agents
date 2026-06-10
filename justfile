set shell := ["sh", "-eu", "-c"]
# On Windows `sh` is usually not on PATH, but Git for Windows ships bash. Point
# just at it directly so the POSIX recipe bodies run unchanged. Override with a
# different absolute path if Git is installed elsewhere.
set windows-shell := ["C:\\Program Files\\Git\\bin\\bash.exe", "-eu", "-c"]

repo := justfile_directory()
home := env("HOME", env("USERPROFILE", ""))

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
    cd "{{ repo }}" && cargo build --release -p ct -p vlt

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

setup: node-deps-install pi-node-modules-link doctor link install validate

node-deps-install:
    cd "{{ repo }}" && bun install

pi-node-modules-link:
    cd "{{ repo }}" && cargo xtask link-node-modules

codex-plugins-install:
    cd "{{ repo }}" && cargo xtask codex-plugins-install

install:
    @cargo install --list | grep -q '^worktrunk ' || cargo binstall worktrunk --locked --no-confirm || echo "warning: worktrunk install failed; continuing without it" >&2
    @cargo install --list | grep -q '^git-surgeon ' || cargo binstall git-surgeon --locked --no-confirm || echo "warning: git-surgeon install failed (no prebuilt binary; source build is Unix-only); continuing without it" >&2
    cargo install --path "{{ repo }}/crates/ct"
    cargo install --path "{{ repo }}/crates/vlt"
    cargo install --path "{{ repo }}/crates/sym"
    claude mcp remove -s user vault 2>/dev/null || true
    claude mcp remove -s user source 2>/dev/null || true
    claude mcp remove -s user apply-patch 2>/dev/null || true
    claude mcp remove -s user sym 2>/dev/null || true

completions:
    mkdir -p "{{ home }}/.config/fish/completions"
    ct shell completion fish > "{{ home }}/.config/fish/completions/ct.fish"
