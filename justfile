set shell := ["sh", "-eu", "-c"]
set windows-shell := ["C:\\Program Files\\Git\\bin\\bash.exe", "-eu", "-c"]

repo := justfile_directory()
home := env("HOME", env("USERPROFILE", ""))

default:
    @just --list

setup:
    @mkdir -p "{{ home }}/.claude" "{{ home }}/.codex"
    @just _seed "{{ repo }}/codex/config.toml" "{{ home }}/.codex/config.toml"
    @just _link "{{ repo }}/claude/CLAUDE.md" "{{ home }}/.claude/CLAUDE.md"
    @just _link "{{ repo }}/claude/settings.json" "{{ home }}/.claude/settings.json"
    @just _link "{{ repo }}/claude/statusline.py" "{{ home }}/.claude/statusline.py"
    @just _link "{{ repo }}/codex/AGENTS.md" "{{ home }}/.codex/AGENTS.md"
    @just _link "{{ repo }}/codex/hooks.json" "{{ home }}/.codex/hooks.json"
    @just check

check:
    @test -f "{{ home }}/.codex/config.toml"
    @just _check-link "{{ repo }}/claude/CLAUDE.md" "{{ home }}/.claude/CLAUDE.md"
    @just _check-link "{{ repo }}/claude/settings.json" "{{ home }}/.claude/settings.json"
    @just _check-link "{{ repo }}/claude/statusline.py" "{{ home }}/.claude/statusline.py"
    @just _check-link "{{ repo }}/codex/AGENTS.md" "{{ home }}/.codex/AGENTS.md"
    @just _check-link "{{ repo }}/codex/hooks.json" "{{ home }}/.codex/hooks.json"

unlink:
    @just _unlink "{{ repo }}/claude/CLAUDE.md" "{{ home }}/.claude/CLAUDE.md"
    @just _unlink "{{ repo }}/claude/settings.json" "{{ home }}/.claude/settings.json"
    @just _unlink "{{ repo }}/claude/statusline.py" "{{ home }}/.claude/statusline.py"
    @just _unlink "{{ repo }}/codex/AGENTS.md" "{{ home }}/.codex/AGENTS.md"
    @just _unlink "{{ repo }}/codex/hooks.json" "{{ home }}/.codex/hooks.json"

_seed source target:
    @if [ ! -e "{{ target }}" ] && [ ! -L "{{ target }}" ]; then cp "{{ source }}" "{{ target }}"; fi

_link source target:
    @if [ -L "{{ target }}" ]; then \
        current="$(readlink "{{ target }}")"; \
        if [ "$current" != "{{ source }}" ]; then \
            echo "refusing to replace {{ target }} -> $current" >&2; \
            exit 1; \
        fi; \
    elif [ -e "{{ target }}" ]; then \
        echo "refusing to replace {{ target }}" >&2; \
        exit 1; \
    else \
        ln -s "{{ source }}" "{{ target }}"; \
    fi

_check-link source target:
    @test -L "{{ target }}"
    @test "$(readlink "{{ target }}")" = "{{ source }}"

_unlink source target:
    @if [ -L "{{ target }}" ] && [ "$(readlink "{{ target }}")" = "{{ source }}" ]; then rm "{{ target }}"; fi
