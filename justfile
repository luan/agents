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
    cargo clippy --workspace --all-targets -- -D warnings && \
    bun run check

test:
    cd "{{ repo }}" && \
    cargo nextest run --workspace && \
    bun run test

# Calls a real model and costs money, so it is kept out of `just test`.
bench-hashline *ARGS:
    cd "{{ repo }}" && bun bench/hashline/main.ts {{ ARGS }}

build:
    cd "{{ repo }}" && cargo build --release

link-dry-run:
    cd "{{ repo }}" && cargo xtask link-dry-run

link:
    cd "{{ repo }}" && cargo xtask link

unlink:
    cd "{{ repo }}" && cargo xtask unlink || true

restow:
    cd "{{ repo }}" && cargo xtask link

doctor:
    cd "{{ repo }}" && cargo xtask doctor
    @command -v node >/dev/null 2>&1 && echo "node: $(node --version)" || echo "node: missing; the notebook code mode host needs it" >&2
    cd "{{ repo }}" && bun pi/agent/extensions/code-mode/notebook/deno-binary.ts --check

validate:
    cd "{{ repo }}" && cargo xtask validate

setup: node-deps-install pi-node-modules-link notebook-prewarm doctor link install validate

node-deps-install:
    cd "{{ repo }}" && bun install

# Downloads the pinned Deno once, ~40 MB. A cached, verified binary is a no-op.
notebook-prewarm:
    cd "{{ repo }}" && bun pi/agent/extensions/code-mode/notebook/deno-binary.ts

pi-node-modules-link:
    cd "{{ repo }}" && cargo xtask link-node-modules


git-spice-install:
    @checkout="{{ home }}/.local/share/agents/git-spice"; \
    mkdir -p "$(dirname "$checkout")" "{{ home }}/.local/bin"; \
    if [ -d "$checkout/.git" ]; then \
        git -C "$checkout" fetch --depth=1 origin +refs/heads/luan/absorb-gh-stack:refs/remotes/origin/luan/absorb-gh-stack; \
    else \
        git clone --depth=1 --branch luan/absorb-gh-stack https://github.com/luan/git-spice.git "$checkout"; \
    fi; \
    git -C "$checkout" checkout --detach --force origin/luan/absorb-gh-stack; \
    want="$(git -C "$checkout" rev-parse HEAD)"; \
    go_bin=""; old_ifs="$IFS"; IFS=:; \
    for dir in $PATH; do case "$dir/go" in */mise/shims/go) continue;; esac; if [ -x "$dir/go" ]; then go_bin="$dir/go"; break; fi; done; \
    IFS="$old_ifs"; test -n "$go_bin"; \
    cd "$checkout" && "$go_bin" build -o "{{ home }}/.local/bin/git-spice" go.abhg.dev/gs; \
    ln -sf git-spice "{{ home }}/.local/bin/gs"; \
    "{{ home }}/.local/bin/git-spice" --version | grep -Fq "$want"

install: git-spice-install build
    @command -v rtk >/dev/null 2>&1 || { command -v brew >/dev/null 2>&1 && brew install rtk-ai/tap/rtk || echo "warning: rtk install failed or Homebrew is unavailable; continuing without it" >&2; }
    @cargo install --list | grep -q '^git-surgeon ' || cargo binstall git-surgeon --locked --no-confirm || echo "warning: git-surgeon install failed (no prebuilt binary; source build is Unix-only); continuing without it" >&2
    @if cargo install --list | grep -q '^ct '; then cargo uninstall ct; fi
    rm -f "{{ home }}/.config/fish/completions/ct.fish"
    @! command -v ct >/dev/null 2>&1 || { echo "error: ct is still installed at $(command -v ct)" >&2; exit 1; }
    cargo install --locked --path "{{ repo }}/crates/vlt"
    claude mcp remove -s user vault 2>/dev/null || true
    claude mcp remove -s user source 2>/dev/null || true
    claude mcp remove -s user apply-patch 2>/dev/null || true
