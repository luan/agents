---
name: python
description: Python execution and dependency rules built on uv. Use when writing or running Python, authoring a standalone script, or managing Python dependencies.
---

# Python

## Execution

Run every Python script and command, including commands in projects with `pyproject.toml`, as `uv run <command>`.
This uses the resolved environment.
Direct `python3` or `python` selects whichever interpreter is on `PATH` and bypasses that environment.

For a standalone script, use this shebang:

```text
#!/usr/bin/env -S uv run --script
```

Put its dependencies in inline dependency metadata.

## Dependencies

- Add dependencies with `uv add`.
- Remove dependencies with `uv remove`.
- Pin versions in `pyproject.toml` as the single source of dependency versions. Keep version pins out of `requirements.txt`.
- Keep dependency changes in the project's lockfile so the environment stays reproducible. Direct `pip install` writes outside that lockfile.
