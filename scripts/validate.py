#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GLOBAL_AGENTS = ROOT / "GLOBAL_AGENTS.md"


def run(args: list[str]) -> None:
    subprocess.run(args, cwd=ROOT, check=True)


def assert_fresh_agents() -> None:
    before = GLOBAL_AGENTS.read_text(encoding="utf-8") if GLOBAL_AGENTS.exists() else ""
    run(["python3", "scripts/render_agents.py"])
    after = GLOBAL_AGENTS.read_text(encoding="utf-8")
    if before != after:
        raise SystemExit("GLOBAL_AGENTS.md was stale; regenerated it. Re-run validation.")


def validate_json(path: Path) -> None:
    with path.open(encoding="utf-8") as handle:
        json.load(handle)


def assert_symlink(path: Path, expected: Path) -> None:
    if not path.is_symlink():
        raise SystemExit(f"{path} must be a symlink")
    if path.resolve() != expected.resolve():
        raise SystemExit(f"{path} resolves to {path.resolve()}, expected {expected.resolve()}")


def assert_no_checkout_paths() -> None:
    needles = ["/" + "Users/", "/" + "private/"]
    checked_roots = [
        ROOT / "AGENTS.md",
        ROOT / "AGENTS.template.md",
        GLOBAL_AGENTS,
        ROOT / "README.md",
        ROOT / "docs",
        ROOT / "rules",
        ROOT / "codex",
        ROOT / "hooks",
        ROOT / "scripts",
        ROOT / "bin",
        ROOT / "claude",
        ROOT / "opencode",
        ROOT / "pi",
        ROOT / "plugins",
        ROOT / ".agents",
    ]
    for root in checked_roots:
        paths = [root] if root.is_file() else sorted(root.rglob("*"))
        for path in paths:
            if not path.is_file() or path.is_symlink():
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            for needle in needles:
                if needle in text:
                    raise SystemExit(f"{path} contains checkout-specific absolute path {needle}")


def main() -> None:
    assert_fresh_agents()
    assert_no_checkout_paths()
    validate_json(ROOT / "codex" / "hooks.json")
    validate_json(ROOT / ".agents" / "plugins" / "marketplace.json")
    validate_json(ROOT / "plugins" / "gt" / ".codex-plugin" / "plugin.json")
    validate_json(ROOT / "plugins" / "gt" / "hooks.json")
    assert_symlink(ROOT / "claude" / "CLAUDE.md", GLOBAL_AGENTS)
    assert_symlink(ROOT / "codex" / "AGENTS.md", GLOBAL_AGENTS)
    assert_symlink(ROOT / "opencode" / "AGENTS.md", GLOBAL_AGENTS)
    assert_symlink(ROOT / "pi" / "AGENTS.md", GLOBAL_AGENTS)
    assert_symlink(ROOT / "claude" / "local-plugins" / "plugins" / "gt", ROOT / "plugins" / "gt")
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp)
        for package in ["claude", "codex", "opencode", "pi", "rules", "skills", "bin"]:
            package_target = target / package
            package_target.mkdir()
            run(["stow", "-n", "-v", "-R", package, "-t", str(package_target)])
    run(["cargo", "test", "--manifest-path", "tools/ct/Cargo.toml"])


if __name__ == "__main__":
    main()
