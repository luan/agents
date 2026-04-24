---
paths:
  - "~/src/chromium/**"
  - "~/src/core-tools/**"
  - "~/src/arc.git/**"
---

# Arc-Core / Chromium Workflow

## Repos

| Repo | Path | Contains |
|------|------|----------|
| chromium | `~/src/chromium/src/arc` | C++ arc-core (ADK bridge, bookmark impl, WinRT) |
| core-tools | `~/src/core-tools` | Build scripts for arc-core |
| arc.git (wt2) | `~/src/arc.git/wt2` | Dia Swift app |

## Agent Teams Required

**Non-negotiable.** Chromium/arc-core work MUST use `TeamCreate` or parallel `Agent` calls. One agent per repo. Never main thread.

## Build Workflow

```bash
# 1. Sync (REQUIRED first — fetches deps, runs hooks)
~/src/core-tools/scripts/core-sync \
  --workspace=~/src

# 2. Build + install ArcCore.framework into Dia
~/src/core-tools/scripts/update-local-arc-core \
  --workspace=~/src \
  --arcRepo=~/src/arc.git/wt2

# 3. Configure + build Dia
just configure-local && just build
```

**Always** pass `--workspace=` explicitly. Always `core-sync` before `update-local-arc-core`. ~5 min incremental.
Agent must NOT report done until build passes.
LSP/clangd diagnostics are false positives — only ninja matters.

## ArcCore Swift Bridge

After arc-core builds with new C++ APIs:
- Wire in `Frameworks/ADK/Sources/ArcCore/ArcCore.swift` (the WinRT→Swift wrapper)
- Until then, stub as `nil` / default value with TODO comment

## Justfile Recipes

- `just configure-local` — configure cmake with `-DUSE_LOCAL_ARCCORE=ON`
- `just configure` — normal configure (uses SPM-published arc-core)
