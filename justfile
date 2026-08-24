set shell := ["sh", "-eu", "-c"]
set windows-shell := ["C:\\Program Files\\Git\\bin\\bash.exe", "-eu", "-c"]

repo := justfile_directory()
home := env("HOME", env("USERPROFILE", ""))

default:
    @just --list

setup:
    @cargo build --locked --manifest-path "{{ repo }}/Cargo.toml" --release
    @cargo xtask harness setup --home "{{ home }}"
    @just home="{{ home }}" check

rust-fmt:
    @cargo fmt --all -- --check

rust-lint:
    # Upstream large_futures ICE workaround; remove when rust-clippy#17601 lands.
    @cargo clippy --locked --all-targets -- -D warnings -A clippy::large_futures

rust-test:
    @cargo nextest run --locked

_build:
    @cargo build --locked --release

_harness-check:
    @cargo xtask harness check --home "{{ home }}"

check: _build rust-fmt rust-lint rust-test _harness-check

unlink:
    @cargo xtask harness unlink --home "{{ home }}"
