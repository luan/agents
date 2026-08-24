# Agents

This repository keeps the agent instructions, Pi extensions, themes, and native tools I use every day. The files stay in Git; `cargo xtask harness setup` links only the managed pieces into the real Claude, Codex, and Pi directories.

The useful part is under `harnesses/pi/agent/packages`: thirteen Pi extensions, two small shared libraries, and no framework hiding how they fit together.

## Set up

You need Rust, Bun 1.3.14, [`just`](https://github.com/casey/just), and Pi.

```sh
git clone https://github.com/luan/agents.git
cd agents
just setup
```

`just setup` builds the Rust binaries, installs the JavaScript dependencies from the lockfile, creates the managed harness links, and runs the complete check suite.

The harness roots remain ordinary directories: `~/.claude`, `~/.codex`, and `~/.pi` are never replaced with symlinks. The setup tool links only the paths listed in `managed.toml`. It refuses to overwrite an unexpected file or a link owned by something else.

Pi's `settings.json` is deliberately mutable. Pi may update the repository copy through its managed link. Credentials, sessions, caches, model stores, and other generated state stay local and out of Git.

To inspect or remove the links:

```sh
cargo xtask harness check
just unlink
```

`just unlink` removes only links that point back to this checkout.

## Pi extensions

Each extension can be loaded from this checkout or installed on its own. Its README explains its settings and public API.

| Package | What it adds |
| --- | --- |
| [`pi-annotations`](harnesses/pi/agent/packages/pi-annotations/README.md) | Comments and reactions attached to transcript selections, sent back as response annotations. |
| [`pi-apply-patch`](harnesses/pi/agent/packages/pi-apply-patch/README.md) | A Codex-compatible `apply_patch` tool backed by the Rust patch parser. |
| [`pi-code-mode`](harnesses/pi/agent/packages/pi-code-mode/README.md) | Restricted JavaScript composition through `exec`, with selected tools available under `tools.*`. |
| [`pi-codex-native`](harnesses/pi/agent/packages/pi-codex-native/README.md) | The Codex Responses provider, models, native web tool, compaction, and provider controls. |
| [`pi-copy-mode`](harnesses/pi/agent/packages/pi-copy-mode/README.md) | Keyboard-driven character, line, and column selection in Pi's fullscreen transcript. |
| [`pi-developer-prompt`](harnesses/pi/agent/packages/pi-developer-prompt/README.md) | Provider instructions, developer messages, environment context, and prompt inspection. |
| [`pi-exec-command`](harnesses/pi/agent/packages/pi-exec-command/README.md) | Bounded shell commands and persistent PTY sessions through `exec_command` and `write_stdin`. |
| [`pi-libtui`](harnesses/pi/agent/packages/pi-libtui/README.md) | Shared terminal components, semantic colors, mouse handling, selection bridges, and tool presentation. |
| [`pi-model-roles`](harnesses/pi/agent/packages/pi-model-roles/README.md) | Named model and thinking profiles with ordered fallbacks. |
| [`pi-skills`](harnesses/pi/agent/packages/pi-skills/README.md) | Exact-name skill loading through the `skill` tool. |
| [`pi-tool-search`](harnesses/pi/agent/packages/pi-tool-search/README.md) | Search and activation for a configured set of deferred tools. |
| [`pi-view-image`](harnesses/pi/agent/packages/pi-view-image/README.md) | A Codex-compatible native image attachment tool. |
| [`pi-xsettings`](harnesses/pi/agent/packages/pi-xsettings/README.md) | Typed settings registration, TOML persistence, keybindings, and the `/xsettings` editor. |

## Shared Pi libraries

These packages register no Pi extension by themselves.

| Package | What it owns |
| --- | --- |
| [`pi-libactions`](harnesses/pi/agent/packages/pi-libactions/README.md) | The UI-free custom-action registry and validated `keybindings.json` loader. |
| [`pi-libcontext`](harnesses/pi/agent/packages/pi-libcontext/README.md) | The UI-free context-window preference registry shared by model and provider extensions. |

`pi-libtui` is the one deliberate dual-role package: imports expose reusable components without side effects, while its extension entry point installs generic terminal compatibility for Pi.

## Native tools

TypeScript registers and composes Pi features. Rust owns the process, patch, protocol, and JavaScript-runtime boundaries.

| Crate | Responsibility |
| --- | --- |
| `apply-patch` | Parses and applies structured patches. |
| `code-mode-host` | Runs the Code Mode host process. |
| `code-mode-protocol` | Defines the host wire protocol. |
| `code-mode-runtime` | Executes restricted JavaScript and coordinates nested calls. |
| `exec-command` | Runs bounded pipes and persistent PTY sessions. |
| `web-run` | Executes the native Codex web request contract. |
| `view-image` | Reads local images for Codex-compatible attachment previews. |
| `xtask` | Sets up, checks, and removes managed harness links. |

## Configure Pi

The checked-in Pi setup uses three files:

- `harnesses/pi/agent/settings.json` selects packages, models, theme, and Pi-owned behavior.
- `harnesses/pi/agent/xsettings.toml` stores settings contributed by extensions. Open it interactively with `/xsettings` or `Ctrl-,`.
- `harnesses/pi/agent/keybindings.json` owns Pi bindings and every custom extension action.

Tool visibility has three separate controls:

- `pi.defaultTools` selects direct tools.
- `pi-code-mode.tools` moves selected active tools under `exec`.
- `pi-tool-search.tools` defers selected tools within the scope where `tool_search` runs.

Code Mode alone changes tool hierarchy. Tool Search only controls deferred membership; a disabled tool is not silently made deferred.

Run `/reload` after changing package loading, keybindings, or a setting documented as reload-only. Appearance and other live settings apply immediately when their package says they do.

## Work on the repository

```sh
just check
```

On a warm checkout this builds the release binaries once, then runs the checks in phases:

- Biome formatting and Pi policy lint;
- cached TypeScript checks for every package;
- every Bun test in every package;
- Rust formatting, Clippy, and the complete workspace through Nextest;
- managed harness validation.

No Rust test is ignored. `cargo nextest run --locked` runs the whole virtual Rust workspace.

Useful narrower commands:

```sh
bun run typecheck
bun run test:pi
cargo nextest run --locked
```

## Common problems

**A native tool says its binary is missing.** Run `cargo build --locked --release`, or `just setup` to rebuild and check everything.

**A tool is not visible.** Check all three tool lists above. Under strict selection, `exec`, `tool_search`, and direct tools exist only when the active scope includes them.

**A fullscreen interaction is absent.** Copy mode, mouse overlays, and some selection UI require Pi's fullscreen TUI. Check `pi.tuiMode` in `xsettings.toml`.

**Setup refuses a path.** Inspect it before changing anything. The refusal means a real file or an unexpected link occupies a managed location; setup will not delete it for you.

**A package works here but not alone.** From `harnesses/pi/agent`, run `pi install packages/<name>`. Each package keeps its runtime dependencies in its own manifest, so a standalone install failure is a package bug.
