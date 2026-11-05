# Agents

This repository keeps the agent instructions, Pi extensions, themes, and native tools I use every day. The files stay in Git; `cargo xtask harness setup` links only the managed pieces into the real Claude, Codex, and Pi directories.

The useful part is under `harnesses/pi/agent/packages`: thirteen Pi extensions, two small shared libraries, and no framework hiding how they fit together.

## Set up

You need Rust, Bun 1.4.4, [`just`](https://github.com/casey/just), and Pi.

The voice host links against the system Opus library, which it finds through `pkg-config`. Without `pkg-config`, the build falls back to Opus's bundled CMake project, and CMake 4 rejects that project. On macOS, run `brew install opus pkgconf`. On Linux, also install the ALSA headers (`libasound2-dev`).

```sh
git clone https://github.com/luan/agents.git
cd agents
just setup
```

`just setup` builds the Rust binaries, installs the JavaScript dependencies from the lockfile, creates the managed harness links, and runs the complete check suite.

The harness roots remain ordinary directories: `~/.claude`, `~/.codex`, and `~/.pi` are never replaced with symlinks. The setup tool links only the paths listed in `managed.toml`, using the checkout it runs from. Setup automatically repairs conflicting file and dependency links. Before replacing an occupied target, it moves the original file, directory, or symlink into `~/.agents-harness-backups/<target path>/<revision>/original` and prints its location. Existing backups are never overwritten. Move an original back to its target path to restore it; relative symlinks retain their original link text for that restoration. Setup still refuses to traverse symlinked runtime directories.

Claude Code's and Pi's `settings.json` are seeds, not links: apps and the harnesses rewrite them, so setup copies the repository version once and the local file stays out of Git. A machine manager can merge later repository changes into it. Credentials, sessions, caches, model stores, and other generated state stay local and out of Git.

Package build metadata (`*.tsbuildinfo`) is excluded from harness links.

To inspect or remove the links:

```sh
cargo xtask harness check
just unlink
```

`just unlink` removes only links that point back to this checkout.

## Pi extensions

Each extension can be loaded from this checkout or installed on its own. Its README explains its settings and public API.

- [`@luan.sh/pi-fileops`](harnesses/pi/agent/packages/pi-fileops/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-fileops)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-fileops) — A Codex-compatible `apply_patch` tool backed by the Rust patch parser.
- [`@luan.sh/pi-codex-native`](harnesses/pi/agent/packages/pi-codex-native/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-codex-native)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-codex-native) — The Codex Responses provider, models, native web tool, compaction, and provider controls.
- [`@luan.sh/pi-copy-mode`](harnesses/pi/agent/packages/pi-copy-mode/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-copy-mode)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-copy-mode) — Vim-style transcript selection, copying, comments, and reactions.
- [`@luan.sh/pi-collapse-transcript`](harnesses/pi/agent/packages/pi-collapse-transcript/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-collapse-transcript)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-collapse-transcript) — Collapsible tools and thinking sections with a live activity summary.
- [`@luan.sh/pi-developer-messages`](harnesses/pi/agent/packages/pi-developer-messages/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-developer-messages)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-developer-messages) — Provider instructions, developer messages, environment context, and prompt inspection.
- [`@luan.sh/pi-exec-command`](harnesses/pi/agent/packages/pi-exec-command/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-exec-command)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-exec-command) — Bounded shell commands and persistent PTY sessions through `exec_command` and `write_stdin`.
- [`@luan.sh/pi-libtui`](harnesses/pi/agent/packages/pi-libtui/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-libtui)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-libtui) — Shared terminal components, semantic colors, mouse handling, selection bridges, and tool presentation.
- [`@luan.sh/pi-skills`](harnesses/pi/agent/packages/pi-skills/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-skills)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-skills) — Exact-name skill loading through the `skill` tool.
- [`@luan.sh/pi-view-image`](harnesses/pi/agent/packages/pi-view-image/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-view-image)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-view-image) — A Codex-compatible native image attachment tool.
- [`@luan.sh/pi-xsettings`](harnesses/pi/agent/packages/pi-xsettings/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-xsettings)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-xsettings) — Typed settings registration, TOML persistence, keybindings, and the `/xsettings` editor.
- [`@luan.sh/pi-custom-editor`](harnesses/pi/agent/packages/pi-custom-editor/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-custom-editor)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-custom-editor) — Custom editor layouts, file and skill tokens, and a semantic status footer.
- [`@luan.sh/pi-panels`](harnesses/pi/agent/packages/pi-panels/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-panels)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-panels) — Contributed side-panel tabs with focus, resize, reorder, and zoom controls.
- [`@luan.sh/pi-prompt-storage`](harnesses/pi/agent/packages/pi-prompt-storage/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-prompt-storage)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-prompt-storage) — Draft stashing and searchable prompt history.
- [`@luan.sh/pi-side`](harnesses/pi/agent/packages/pi-side/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-side)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-side) — Independent side conversations alongside the main session.
- [`@luan.sh/pi-subagents`](harnesses/pi/agent/packages/pi-subagents/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-subagents)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-subagents) — Concurrent, nested subagents with an Agent Hub for inspecting their work.
- [`@luan.sh/pi-thinking-binding`](harnesses/pi/agent/packages/pi-thinking-binding/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-thinking-binding)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-thinking-binding) — Drops Anthropic thinking blocks invalidated by system-prompt or tool changes.
- [`@luan.sh/pi-tuicr`](harnesses/pi/agent/packages/pi-tuicr/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-tuicr)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-tuicr) — Embedded Tuicr review with comments returned to Pi as prompt attachments.

## Shared Pi libraries

These packages register no Pi extension by themselves.

- [`@luan.sh/pi-libactions`](harnesses/pi/agent/packages/pi-libactions/README.md)&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-libactions)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-libactions) — The UI-free custom-action registry and validated `keybindings.json` loader.

`@luan.sh/pi-libtui` is the one deliberate dual-role package: imports expose reusable components without side effects, while its extension entry point installs generic terminal compatibility for Pi.

## Native tools

TypeScript registers and composes Pi features. Rust owns the process, patch, protocol, and JavaScript-runtime boundaries.

| Crate | Responsibility |
| --- | --- |
| `apply-patch` | Parses and applies structured patches. |
| `terminal-bridge` | Runs bounded pipes and persistent PTY sessions. |
| `web-run` | Executes the native Codex web request contract. |
| `view-image` | Reads local images for Codex-compatible attachment previews. |
| `xtask` | Sets up, checks, and removes managed harness links. |

## Configure Pi

The checked-in Pi setup uses three files:

- `harnesses/pi/agent/settings.json` selects packages, models, theme, and Pi-owned behavior.
- `harnesses/pi/agent/xsettings.toml` stores settings contributed by extensions. Open it interactively with `/xsettings` or `Ctrl-,`.
- `harnesses/pi/agent/keybindings.json` owns Pi bindings and every custom extension action.

Use `Alt+P` for Pi's model picker and `Alt+,` / `Alt+.` to decrease or increase
reasoning effort. Subagents inherit the parent's model and effort unless a
spawn supplies direct overrides.

The managed harness requires Pi 1.4.0 or later and uses its built-in `codemode`,
`tool_search`, and MCP support. `pi.defaultTools` selects tools; the managed
`codemode.mode = "only"` routes callable tools through JavaScript scripts.
Configured tools are restored automatically on session startup, resume, reload,
and branch navigation.
Pi 0.99.2 fixes activation of newly configured default tools during `/reload`.
MCP servers belong in Pi's `mcp.json` and are managed with `/mcp` or `pi mcp`.

Scripts use `tools.*`, `text()`, `image()`, `store()`/`load()`, and
`searchTools()`/`describeTool()`. They run in a fresh QuickJS sandbox; there is
no notebook kernel or `exec`/`wait` cell lifecycle. Use `exec_command` and
`write_stdin` for persistent processes. The custom Code Mode, Tool Search,
and notebook implementations and their compatibility adapters have been removed.
Image tools, conversation controls, context rollover, and collaboration stay
direct. Shell tools expose structured output to scripts. SDK subagents opt into
the built-ins and respect Pi's built-in disable settings.

The Codex Native provider stays enabled for native checkpoints, context recovery,
Astra controls, web search, and quota handling. Its catalog comes from Pi and
includes GPT-6.1 Sol. The default is GPT-6 Luna; Astra, both Sol generations, and
Luna remain in the model picker. Pi's new `/login openai` subscription route is
available independently, but does not replace those native provider features.

Run `/reload` after changing package loading, keybindings, or a setting documented as reload-only. Appearance and other live settings apply immediately when their package says they do.

## Work on the repository

```sh
just check
```

On a warm checkout this builds the release binaries once, then runs the checks in phases:

- Biome formatting and Pi policy lint;
- cached TypeScript checks for every package;
- every package's test command in a separate process, run in parallel with
  package-labelled output (no shared cross-package test state);
- Rust formatting, Clippy, and the complete workspace through Nextest;
- managed harness validation.

No Rust test is ignored. `cargo nextest run --locked` runs the whole virtual Rust workspace.
Each check prints its command; `All checks passed.` appears only after every
phase succeeds. The test runner does not retry failures.

Useful narrower commands:

```sh
bun run typecheck
bun run test:pi
cargo nextest run --locked
```

See [the package migration](docs/pi-package-migration.md) for renamed packages and upgrade instructions.

## Documentation site

[pi.luan.sh](https://pi.luan.sh) renders the package READMEs and `docs/` into a static site. `site/build.ts` uses
`Bun.markdown` plus Shiki for code blocks; `site/fonts` holds the bundled IBM Plex Sans and Maple Mono NF faces (OFL 1.1).

```sh
just site        # writes site/dist
just site-dev    # serves it on http://localhost:4321 and rebuilds on change
```

Cloudflare builds it with `bun run build:site` and serves `site/dist` as static
assets per `wrangler.jsonc`. The explicit config is required because Cloudflare
refuses to auto-detect a project at the root of a Bun workspace.

## Release

Each package has its own version and release tag. Bump only the package being
released, commit, then tag that commit with its full npm name and version:

```sh
git tag @luan.sh/pi-codex-native@0.3.8
git push origin main @luan.sh/pi-codex-native@0.3.8
```

`.github/workflows/publish.yml` publishes only the named package, checks that
its version matches the tag, and skips versions already on npm. Other packages
may have the same version without being released. Tags include the scope, for example `@luan.sh/pi-exec-command@0.3.9`.
Packages with `publishAliases` also publish the same release under the listed
bare names. Existing versions are skipped independently for each name.

CI authenticates with npm trusted publishing (OIDC); each package must list
this repository's `publish.yml` as a trusted publisher on npmjs.com once.
`just pi-publish <package>` is the CI publishing recipe and requires checkout
of that package's release tag with clean package and native sources.

The pack step records the exact Git commit in every bundled native runtime.
Native builds and caches use that commit, independently of package versions.
Keep released commits reachable and never move or delete release tags.

## Common problems

**A native tool says its binary is missing.** Run `cargo build --locked --release`, or `just setup` to rebuild and check everything.

**A tool is not visible.** Check `defaultTools`, the tool's exposure, and MCP server
configuration. Enable `codemode` for script calls and `tool_search` to discover
deferred tools. Strict `--tools` selection replaces the startup selection.

**A fullscreen interaction is absent.** Copy mode, mouse overlays, and some selection UI require Pi's fullscreen TUI. Check `pi.tuiMode` in `xsettings.toml`.

**Setup refuses a path.** Inspect it before changing anything. The refusal means a real file or an unexpected link occupies a managed location; setup will not delete it for you.

**A package works here but not alone.** From `harnesses/pi/agent`, run `pi install packages/<name>`. Each package keeps its runtime dependencies in its own manifest, so a standalone install failure is a package bug.
