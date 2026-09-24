# Luan's Pi extensions

Documentation for the Pi extensions, shared libraries, and native tools kept in
[luan/agents](https://github.com/luan/agents). Each package page is that
package's README: installation, settings, tools, keybindings, and the layout of
its source. The repository pages describe the architecture every package
follows.

## Install

Every package installs on its own with Pi's package manager:

```sh
pi install npm:<package>
```

Packages that use a native binary require a Rust toolchain
(https://rustup.rs). The binary builds on first use under Pi's agent
directory; each package page names the binary and the environment variable
that points Pi at a prebuilt one instead.

Run `/reload` after changing package loading, keybindings, or a setting
documented as reload-only.

## Extensions

### Conversation and context recovery

[`pi-conversation`](/packages/pi-conversation/) lets the agent ask questions and
send answers while work continues. Reply directly through inline choices or the text field. These tools work in ordinary mode. Optional **Persistent** mode uses Astra's exact
Codex catalog instructions to continue useful authorized follow-up while delivering
answers asynchronously. Configure it in the existing Codex Native settings UI.
The selection is saved with the current session. No slash commands are needed.

[`pi-context-windows`](/packages/pi-context-windows/) provides fresh windows, searchable history,
and working notes that survive rollover and resume. Both use public Pi APIs and
work with the native Codex provider, including Astra. Read the
[topology and operation guide](/docs/pi-context-and-conversation/).

### Voice, notebooks, and images

[`pi-voice`](/packages/pi-voice/) adds Voice, Dictate, and Phone controls to the
Pi editor. [`pi-notebook`](/packages/pi-notebook/) keeps Deno bindings between
cells and restores saved values after restart.
[`pi-imagegen`](/packages/pi-imagegen/) uses the standalone upstream imagegen
package with our tool presentation.

Codex Native also provides native Astra effort updates and an account usage
panel. Context Windows can generate recovery summaries and archive completed
windows in the Pi tree. See [how to try these features](/docs/pi-context-and-conversation/#try-the-additional-features).

<!-- extensions -->

## Libraries

Library packages register no Pi extension by themselves. `@luan.sh/pi-libtui` is the one
dual-role package: imports expose reusable components without side effects,
and its extension entry point installs terminal compatibility for Pi.

<!-- libraries -->

## Configuration

Extensions read three files from Pi's agent directory, normally `~/.pi/agent`:

| File | Owns |
| --- | --- |
| `settings.json` | Packages, models, theme, and Pi-owned behavior. |
| `xsettings.toml` | Settings contributed by extensions. Edit interactively with `/xsettings` when [`@luan.sh/pi-xsettings`](/packages/pi-xsettings/) is installed; otherwise each package's compiled defaults apply. |
| `keybindings.json` | Pi bindings and every custom extension action. Extensions ship no default keys for custom actions. |

Tool visibility has three separate controls:

- `pi.defaultTools` selects direct tools.
- `pi-code-mode.tools` moves selected active tools under `exec`.
- `pi-tool-search.tools` defers selected tools within the scope where `tool_search` runs.

Code Mode alone changes tool hierarchy. Tool Search only controls deferred
membership; a disabled tool is not silently made deferred.

## Native tools

TypeScript registers and composes Pi features. Rust owns the process, patch,
protocol, and JavaScript-runtime boundaries.

| Crate | Responsibility |
| --- | --- |
| `apply-patch` | Parses and applies structured patches. |
| `code-mode-host` | Runs the Code Mode host process. |
| `code-mode-protocol` | Defines the host wire protocol. |
| `code-mode-runtime` | Executes restricted JavaScript and coordinates nested calls. |
| `terminal-bridge` | Runs bounded pipes and persistent PTY sessions. |
| `web-run` | Executes the native Codex web request contract. |
| `notebook-host` | Owns the persistent Deno kernel and saved bindings. |
| `voice-host` | Microphone, speaker, Opus, and WebRTC for voice. |
| `view-image` | Reads local images for Codex-compatible attachment previews. |
