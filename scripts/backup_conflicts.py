#!/usr/bin/env python3
from __future__ import annotations

import os
import shutil
import sys
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


TARGETS = [
    ("claude", Path.home() / ".claude"),
    ("codex", Path.home() / ".codex"),
    ("opencode", Path.home() / ".config" / "opencode"),
    ("pi", Path.home() / ".pi"),
    ("rules", Path.home() / ".agents" / "rules"),
    ("skills", Path.home() / ".agents" / "skills"),
    ("skills", Path.home() / ".claude" / "skills"),
    ("bin", Path.home() / "bin"),
]


def is_repo_owned(path: Path) -> bool:
    if not path.is_symlink():
        return False
    try:
        return path.resolve().is_relative_to(ROOT)
    except FileNotFoundError:
        return False


def package_entries(package: Path) -> list[Path]:
    if not package.exists():
        return []
    return sorted(path for path in package.iterdir() if path.name != ".DS_Store")


def backup_path(target: Path, backup_root: Path) -> Path:
    rel = target.relative_to(Path.home())
    return backup_root / rel


def main() -> None:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_root = ROOT / ".backup" / stamp
    moved: list[tuple[Path, Path]] = []

    for package_name, target_dir in TARGETS:
        package_dir = ROOT / package_name
        for entry in package_entries(package_dir):
            target = target_dir / entry.name
            if not os.path.lexists(target) or is_repo_owned(target):
                continue
            destination = backup_path(target, backup_root)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(target), str(destination))
            moved.append((target, destination))

    if not moved:
        print("No existing target conflicts needed backup.")
        return

    print(f"Backed up {len(moved)} existing target path(s) under {backup_root}:")
    for target, destination in moved:
        print(f"  {target} -> {destination}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"backup failed: {exc}", file=sys.stderr)
        raise
