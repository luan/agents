#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HOME = Path.home()

TARGETS = [
    ("claude", HOME / ".claude"),
    ("codex", HOME / ".codex"),
    ("opencode", HOME / ".config" / "opencode"),
    ("pi", HOME / ".pi"),
    ("rules", HOME / ".agents" / "rules"),
    ("skills", HOME / ".agents" / "skills"),
    ("skills", HOME / ".claude" / "skills"),
]

LEGACY_BIN_LINKS = ["agents-hook", "opencode"]


def command(mode: str, package: str, target: Path) -> list[str]:
    action = {"dry-run": "-R", "link": "-R", "unlink": "-D"}[mode]
    cmd = ["stow", action]
    if mode == "dry-run":
        cmd = ["stow", "-n", "-v", action]
    return cmd + [package, "-t", str(target)]


def cleanup_legacy_bin_links() -> None:
    bin_dir = HOME / "bin"
    for name in LEGACY_BIN_LINKS:
        link = bin_dir / name
        if not link.is_symlink():
            continue
        try:
            if link.resolve().is_relative_to(ROOT / "bin"):
                print(f"- unlink legacy {link}", flush=True)
                link.unlink()
        except FileNotFoundError:
            link.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["dry-run", "link", "unlink"])
    args = parser.parse_args()

    if args.mode in {"link", "unlink"}:
        cleanup_legacy_bin_links()

    status = 0
    for package, target in TARGETS:
        target.mkdir(parents=True, exist_ok=True)
        cmd = command(args.mode, package, target)
        print("+ " + " ".join(cmd), flush=True)
        proc = subprocess.run(cmd, cwd=ROOT)
        if proc.returncode != 0:
            status = proc.returncode
            if args.mode == "link":
                break

    sys.exit(status)


if __name__ == "__main__":
    main()
