---
name: pi-vendor
description: Vendor an installed Pi extension into this repo's pi/agent/extensions/ tree and move only required runtime dependencies into the repo package.json. Use when asked to vendor, inline, localize, fork, or customize an installed Pi extension/package for this agents repo.
---

# Pi Vendor

Vendor an installed Pi extension into this repository only. Do not use this skill outside this repo.

## Quick start

Given an installed package like `npm:pi-web-access`:

1. Locate the installed package and entrypoints:
   ```sh
   pi list
   npm view <package> pi dependencies peerDependencies --json
   ```
2. Copy only the extension runtime files needed by the `pi.extensions` entrypoint into:
   ```text
   pi/agent/extensions/<extension-name>/
   ```
3. Move third-party runtime dependencies to the repo root `package.json` `dependencies`.
4. Replace the package entry in `pi/agent/settings.json` with the local vendored extension, or rely on auto-discovery if the vendored directory has `index.ts`.
5. Run validation and a Pi load smoke test.

## Workflow

### 1. Inspect before copying

- Read the installed package `package.json`.
- Identify the exact Pi extension entrypoints from `package.json` `pi.extensions`.
- Build the dependency graph from those entrypoints using imports, not by copying the whole package.
- Include local files that are imported by runtime code.
- Exclude unused docs, tests, examples, screenshots, videos, source maps, build config, package lockfiles, and nested `node_modules`.

Useful commands:

```sh
npm root -g
pi list
find <installed-package> -maxdepth 2 -type f
rg '^import|from "\.|from '\''\.' <installed-package>
```

### 2. Vendor source into this repo

- Create `pi/agent/extensions/<extension-name>/`.
- Preserve relative file layout needed by local imports.
- Prefer TypeScript source files if Pi can load them directly.
- Keep package-local data files only when runtime code reads them.
- Do not vendor `node_modules`; dependencies belong in root `package.json`.

### 3. Port dependencies

- Read the installed package `dependencies` and `peerDependencies`.
- Add only runtime dependencies that the vendored code imports and this repo does not already provide.
- Keep Pi packages (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, `typebox`) aligned with existing repo versions unless the vendored package requires a newer compatible range.
- Do not add dev-only tooling from the vendored package.
- Update the root `package.json`; update the lockfile only by running the package manager after the manifest edit.

### 4. Update Pi settings

- Remove the original package from `pi/agent/settings.json` once the local extension is in place.
- If the vendored extension is auto-discovered via `pi/agent/extensions/<name>/index.ts`, do not also list it in settings.
- Keep settings portable: no checkout-specific absolute paths.

### 5. Verify

Run:

```sh
npm install
just validate
PI_OFFLINE=1 pi --no-skills --no-prompt-templates --no-themes --no-context-files --no-session -p ""
```

Then smoke-test the registered tools or commands. For tool-only extensions, load the extension and call a cheap tool path where practical.

## Guardrails

- Use `apply_patch` for repo edits.
- Delete dead code; do not leave commented-out package shims.
- Do not vendor generated dependencies, caches, or package-manager metadata unless runtime code reads them.
- Do not commit machine-specific absolute paths.
- If a dynamic import or runtime file read makes dependency reachability unclear, inspect that code path and document why each included file is necessary.
