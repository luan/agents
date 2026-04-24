---
paths:
  - "/Users/luan.santos/src/chromium/**"
  - "/Users/luan.santos/src/core-tools/**"
  - "/Users/luan.santos/src/arc.git/**"
---

# Arc-Core / Chromium Workflow

## Repos

| Repo | Path | Contains |
|------|------|----------|
| chromium | `/Users/luan.santos/src/chromium/src/arc` | C++ arc-core (ADK bridge, bookmark impl, WinRT) |
| core-tools | `/Users/luan.santos/src/core-tools` | Build scripts for arc-core |
| arc.git (wt2) | `/Users/luan.santos/src/arc.git/wt2` | Dia Swift app |

## Agent Teams Required

**Non-negotiable.** Chromium/arc-core work MUST use `TeamCreate` or parallel `Agent` calls. One agent per repo. Never main thread.

## Build Workflow

```bash
# 1. Sync (REQUIRED first — fetches deps, runs hooks)
/Users/luan.santos/src/core-tools/scripts/core-sync \
  --workspace=/Users/luan.santos/src

# 2. Build + install ArcCore.framework into Dia
/Users/luan.santos/src/core-tools/scripts/update-local-arc-core \
  --workspace=/Users/luan.santos/src \
  --arcRepo=/Users/luan.santos/src/arc.git/wt2

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
