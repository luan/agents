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
    bun run check

test:
    cd "{{ repo }}" && \
    cargo nextest run && \
    bun run test

build: context-guard
    cd "{{ repo }}" && cargo build --release -p context-guard -p ct -p vlt

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

context-guard:
    cd "{{ repo }}" && cargo build -p context-guard

git-spice-install:
    @checkout="{{ home }}/.local/share/agents/git-spice"; \
    mkdir -p "$(dirname "$checkout")" "{{ home }}/.local/bin"; \
    if [ -d "$checkout/.git" ]; then \
        git -C "$checkout" fetch --depth=1 origin luan/github-stacks; \
    else \
        git clone --depth=1 --branch luan/github-stacks https://github.com/luan/git-spice.git "$checkout"; \
    fi; \
    git -C "$checkout" checkout --detach --force origin/luan/github-stacks; \
    go_bin=""; old_ifs="$IFS"; IFS=:; \
    for dir in $PATH; do case "$dir/go" in */mise/shims/go) continue;; esac; if [ -x "$dir/go" ]; then go_bin="$dir/go"; break; fi; done; \
    IFS="$old_ifs"; test -n "$go_bin"; \
    cd "$checkout" && "$go_bin" build -o "{{ home }}/.local/bin/git-spice" go.abhg.dev/gs

install: context-guard git-spice-install
    @command -v rtk >/dev/null 2>&1 || { command -v brew >/dev/null 2>&1 && brew install rtk-ai/tap/rtk || echo "warning: rtk install failed or Homebrew is unavailable; continuing without it" >&2; }
    @cargo install --list | grep -q '^git-surgeon ' || cargo binstall git-surgeon --locked --no-confirm || echo "warning: git-surgeon install failed (no prebuilt binary; source build is Unix-only); continuing without it" >&2
    cargo install --path "{{ repo }}/crates/ct"
    cargo install --path "{{ repo }}/crates/vlt"
    cargo install --path "{{ repo }}/crates/context-guard"
    claude mcp remove -s user vault 2>/dev/null || true
    claude mcp remove -s user source 2>/dev/null || true
    claude mcp remove -s user apply-patch 2>/dev/null || true

completions:
    mkdir -p "{{ home }}/.config/fish/completions"
    ct shell completion fish > "{{ home }}/.config/fish/completions/ct.fish"
