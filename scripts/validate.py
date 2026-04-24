#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run(args: list[str]) -> None:
    subprocess.run(args, cwd=ROOT, check=True)


def assert_fresh_agents() -> None:
    before = (ROOT / "AGENTS.md").read_text(encoding="utf-8") if (ROOT / "AGENTS.md").exists() else ""
    run(["python3", "scripts/render_agents.py"])
    after = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    if before != after:
        raise SystemExit("AGENTS.md was stale; regenerated it. Re-run validation.")


def validate_json(path: Path) -> None:
    with path.open(encoding="utf-8") as handle:
        json.load(handle)


def assert_symlink(path: Path, expected: Path) -> None:
    if not path.is_symlink():
        raise SystemExit(f"{path} must be a symlink")
    if path.resolve() != expected.resolve():
        raise SystemExit(f"{path} resolves to {path.resolve()}, expected {expected.resolve()}")


def main() -> None:
    assert_fresh_agents()
    validate_json(ROOT / "codex" / "hooks.json")
    validate_json(ROOT / ".agents" / "plugins" / "marketplace.json")
    validate_json(ROOT / "plugins" / "gt" / ".codex-plugin" / "plugin.json")
    validate_json(ROOT / "plugins" / "gt" / "hooks.json")
    assert_symlink(ROOT / "claude" / "CLAUDE.md", ROOT / "AGENTS.md")
    assert_symlink(ROOT / "codex" / "AGENTS.md", ROOT / "AGENTS.md")
    assert_symlink(ROOT / "opencode" / "AGENTS.md", ROOT / "AGENTS.md")
    assert_symlink(ROOT / "pi" / "AGENTS.md", ROOT / "AGENTS.md")
    assert_symlink(ROOT / "claude" / "local-plugins" / "plugins" / "gt", ROOT / "plugins" / "gt")
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp)
        for package in ["claude", "codex", "opencode", "pi", "rules", "skills", "bin"]:
            package_target = target / package
            package_target.mkdir()
            run(["stow", "-n", "-v", "-R", package, "-t", str(package_target)])
    run(["cargo", "test", "--manifest-path", "tools/ct/Cargo.toml"])
    if os.environ.get("OPENCODE_DISABLE_CLAUDE_CODE") != "1":
        print("warning: OPENCODE_DISABLE_CLAUDE_CODE=1 is not active in this shell", file=sys.stderr)


if __name__ == "__main__":
    main()
