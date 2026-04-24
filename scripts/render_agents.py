#!/usr/bin/env python3
from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "AGENTS.template.md"
OUTPUT = ROOT / "GLOBAL_AGENTS.md"
RULES_DIR = ROOT / "rules"
BEGIN = "<!-- BEGIN GENERATED RULES -->"
END = "<!-- END GENERATED RULES -->"


def parse_rule(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    description = ""
    body = text

    if text.startswith("---\n"):
        _, frontmatter, body = text.split("---\n", 2)
        for line in frontmatter.splitlines():
            key, sep, value = line.partition(":")
            if sep and key.strip() in {"description", "summary"}:
                description = value.strip().strip("\"'")
                break

    title = ""
    for line in body.splitlines():
        match = re.match(r"^#\s+(.+?)\s*$", line)
        if match:
            title = match.group(1).strip()
            break

    if not title:
        title = path.stem.replace("-", " ").title()
    if not description:
        description = title
    return title, description


def installed_rule_path(path: Path) -> str:
    return f"~/.agents/rules/{path.name}"


def render_rules() -> str:
    if not RULES_DIR.exists():
        return "_No shared rules are currently defined._\n"

    lines: list[str] = []
    for path in sorted(RULES_DIR.glob("*.md")):
        title, description = parse_rule(path)
        rel = path.relative_to(ROOT)
        lines.append(f"- `{rel}` ({installed_rule_path(path)}): {title} - {description}")

    if not lines:
        return "_No shared rules are currently defined._\n"
    return "\n".join(lines) + "\n"


def main() -> None:
    template = TEMPLATE.read_text(encoding="utf-8")
    if BEGIN not in template or END not in template:
        raise SystemExit(f"{TEMPLATE} must contain generated rules markers")

    before, rest = template.split(BEGIN, 1)
    _, after = rest.split(END, 1)
    output = before + BEGIN + "\n" + render_rules() + END + after

    if OUTPUT.exists() and OUTPUT.read_text(encoding="utf-8") == output:
        return
    OUTPUT.write_text(output, encoding="utf-8")


if __name__ == "__main__":
    main()
