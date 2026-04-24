#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys


def main() -> None:
    payload = sys.stdin.read()
    proc = subprocess.run(
        ["ct", "sym", "hook", "nudge", "--format=json"],
        input=payload,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return

    data = json.loads(proc.stdout)
    suggestion = data.get("suggest")
    why = data.get("why")
    if not suggestion:
        return

    print(json.dumps({"systemMessage": f"sym can answer this faster: `{suggestion}`. {why}"}))


if __name__ == "__main__":
    main()
