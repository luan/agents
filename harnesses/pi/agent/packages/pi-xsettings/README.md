# @luan.sh/pi-xsettings&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-xsettings)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-xsettings)

`@luan.sh/pi-xsettings` is a settings host for Pi extensions. It adds the
`/xsettings` editor to Pi's interactive TUI, persists Pi and extension settings
in one `xsettings.toml` file, exposes a UI-free SDK
(`@luan.sh/pi-xsettings/sdk`) that other extensions use to declare typed
settings, and binds keys from `keybindings.json` to actions that extensions
register through pi-libactions.

## Preview

![@luan.sh/pi-xsettings in Bootty](https://pi.luan.sh/media/previews/pi-xsettings-25c1f13ef32f.png)

[Watch the demo](https://pi.luan.sh/media/previews/pi-xsettings-6661ed0cbe89.mp4).

## Install

```sh
pi install npm:@luan.sh/pi-xsettings
```

Optional companion: `pi install npm:@luan.sh/pi-panels`. When a side-panel
host is present, `/xsettings` opens as a "Settings" tab beside the session;
without it, the editor opens as a fullscreen overlay.

## Use

In the TUI, run `/xsettings`. Outside the TUI (print, RPC, and other
non-interactive modes) the command only prints a warning.

The left sidebar lists eight pages: UI, Editor, UX, Animations, Terminal,
Behavior, Interaction, and Tools, with each page's sections underneath.
Extension settings appear under the label the extension registered. The search
field at the top filters settings across every page. `/` focuses search; Tab
(or the key bound to `xsettings.cursor.toggle`) toggles focus between sidebar
and content. In the sidebar, arrows or `j`/`k` move and Enter opens the
highlighted destination. In the content, `h`/`l` or left/right change pages,
Enter edits the selected setting, and Backspace restores its default.

Global edits are written to `xsettings.toml` immediately. Settings marked **this
session** are saved in the active session branch and restored on resume; they do
not change other sessions or the global file. Settings
marked live (the theme and all `@luan.sh/pi-libtui` settings) apply to the running TUI
at once. Other settings need a reload: when the editor was opened from
`/xsettings`, Pi reloads after you close it; otherwise it tells you to run
`/reload`.

The mouse wheel scrolls the column under the pointer: the category sidebar or
the settings content. Reaching either end keeps scrolling inside Settings; it
does not move the conversation behind the pane.

## `xsettings.toml`

The file lives in Pi's agent directory, normally `~/.pi/agent/xsettings.toml`.
If it does not exist, the host creates it with a single comment line.

Values are stored under four fixed category tables: `appearance`, `behavior`,
`interaction`, and `tools`. Inside a category, Pi's own settings are keyed
`pi.<key>` and extension settings `<namespace>.<key>`:

```toml
[appearance]
pi.theme = "tokyo-night"
pi-libtui.iconPack = "nerd-fonts"
pi-xsettings.presentation = "fullscreen"

[interaction]
pi.steeringMode = "one-at-a-time"

[tools]
pi.defaultTools = []
```

Unknown keys and other top-level tables are kept but not shown in the editor.
Writes go to a temporary file followed by a rename; a symlinked path has its
target written rather than the link. Comments and layout are not preserved. An
omitted `pi.defaultTools` means "use Pi's default tools"; `pi.defaultTools =
[]` disables every built-in tool.

Recognized Pi settings (theme, compaction, retry, transport, message delivery,
enabled models, default tools, and the other `pi.*` keys shown in the editor)
are synchronized with `settings.json`, which Pi reads before extensions load.
Edits through Pi's `/settings`, model controls, or the JSON file are imported
into TOML; edits through `/xsettings` or TOML are exported to JSON. Bootstrap
values such as packages, trust, telemetry, provider, and model configuration
stay in `settings.json` directly. Project-local settings retain Pi's normal
override behavior and are not imported into global TOML.

Reconciliation runs at startup, before editor saves, on file changes, and at
shutdown. A per-setting baseline lives under `~/.cache/pi-xsettings/`, keyed by
the resolved TOML and JSON paths, outside the managed configuration tree. Deleting that
state starts reconciliation without history. With no baseline, values present
in only one file are copied to the other; differing values present in both
files are left untouched. Later, edits to different settings merge, including
removals. When both sides change the same setting differently, xsettings keeps
both values and reports a conflict. Select the desired value in `/xsettings`
or make both files agree to resolve it. Unrelated settings continue to sync.

Sync uses the same settings-file lock as Pi, rereads both files under that lock,
and preserves managed symlinks. It watches parent directories so atomic file
replacement stays visible. Saved Pi settings still require `/reload` where Pi
does not support live changes; synchronization does not force running sessions
to reload. Invalid files are reported and left untouched until repaired.

## Settings owned by this package

Both namespaces below are registered with `createSettings` and edited via
`/xsettings`; when a value is absent or invalid the default applies.
Namespace `@luan.sh/pi-xsettings` (label "Xsettings") has one key, `presentation`,
default `side-panel` (or `fullscreen`); side-panel falls back to fullscreen
when no panel host is present.

Namespace `@luan.sh/pi-libtui` (label "TUI", all applied live):

| Key | Default |
| --- | --- |
| `iconPack` | `unicode` (`nerd-fonts`, `unicode`, `emoji`) |
| `activityIndicator` / `activityMessage` | `spinner` / `phase` |
| `textEffect` / `textEffectScope` / `pulseEffect` | `off` / `message` / `off` |
| `statusPresentation` | `standard` |
| `animationSpeed` | `normal` (`slow`, `relaxed`, `normal`, `fast`, `very-fast`) |
| `animationSmoothness` | `balanced` (`economy`, `balanced`, `smooth`, `ultra`) |
| `thinking*`, `working*`, `tool*` (`Indicator`, `Message`, `TextEffect`, `PulseEffect`, `Presentation`) | `inherit` (use the General value) |
| `powerline` / `powerlineButtons` / `softCursor` | `false` |
| `insertionCursor` / `navigationCursor` / `selectionCursor` | `virtual` |

## Actions and keybindings

Actions registered by this package: `xsettings.toggle` (open the editor, same
as `/xsettings`), `xsettings.cursor.toggle` (toggle sidebar/content focus
inside the editor, replacing Tab), and `xsettings.effort.decrease` /
`xsettings.effort.increase` (step through the current model's supported
thinking levels, stopping at either end).

None of them has a default key. Bind them in `keybindings.json` in Pi's agent
directory, normally `~/.pi/agent/keybindings.json`. Each property is an action
ID; each value is a key ID string or an array of key ID strings:

```json
{
  "xsettings.toggle": "ctrl+,",
  "xsettings.cursor.toggle": "ctrl+t",
  "xsettings.effort.decrease": ["alt+,"],
  "xsettings.effort.increase": ["alt+."]
}
```

The file is read once when extensions load, so reload Pi after editing it.
Invalid JSON, an invalid key ID, or an unbound action installs no shortcut;
the action stays available through its command or UI. This package is also the
global shortcut host: for every action any installed extension registers
through @luan.sh/pi-libactions, it calls Pi's `registerShortcut()` with the keys
configured for that action ID. Other extensions' READMEs list their action IDs.

## SDK for extension authors

Import the UI-free SDK, not the extension entry point. Declare `scope: "session"`
and `apply: "live"` for a setting saved with the current session. Read those values
with `settings.get(ctx.sessionManager.getSessionId())`; `get()` returns global
values and compiled defaults.


```ts
import { createSettings } from "@luan.sh/pi-xsettings/sdk";

const settings = createSettings({
  namespace: "pi-example",
  label: "Example",
  definitions: {
    enabled: {
      label: "Enabled",
      description: "Enable the example feature.",
      category: "behavior",
      type: "boolean",
      default: true,
    },
    mode: {
      label: "Mode",
      description: "How the feature runs.",
      category: "behavior",
      type: "enum",
      default: "safe",
      options: [{ value: "safe", label: "Safe", description: "" }, { value: "fast", label: "Fast", description: "" }],
    },
  },
});

const unregister = settings.register((values) => { /* values.enabled, values.mode */ });
```

`createSettings()` returns `defaults` (compiled defaults), `get()` (a clone of
the current values), and `register(onValues)` (returns a disposer). Types are
`boolean`, `string`, `enum`, `multi-enum` (with `ordered`), `string-list`
(helper `stringListSetting()`, with `minItems`), and schema-checked `list`
(helper `listSetting(schema, definition)` with a TypeBox schema and a
declarative item definition). Enum options may carry a @luan.sh/pi-libtui `color`, or
point at another setting's list via `{ source: "setting", setting, field }`.

Each definition names a `category` (its TOML table). Optional `page` places it
on one of the eight pages without changing the TOML path (default: the page
matching the category, `appearance` on UI); `section` sets the heading
(default: the registration `label`); `apply` is `"live"` or `"reload"`
(default `"reload"`, overridable per registration); `preview` selects an
animation preview kind. Invalid stored values fall back to the default, enum
values resolve to a valid option, and multi-enum values drop stale choices.

Registration works before the host loads or when it is absent: values arrive
when the host publishes them, and without a host the extension keeps its
defaults. Add `@luan.sh/pi-xsettings` to your package's `dependencies`; do not
create a separate settings file or settings screen.

## Layout

| Responsibility | File |
| --- | --- |
| Pi command, actions, side-panel tab, lifecycle | `src/extension.ts` |
| UI-free SDK | `src/sdk.ts` |
| Cross-extension registry protocol | `src/protocol/settings.ts` |
| `xsettings.toml` load, set, unset, atomic write | `src/config/store.ts` |
| Pi setting definitions | `src/config/pi-settings.ts` |
| `@luan.sh/pi-libtui` and `@luan.sh/pi-xsettings` definitions | `src/config/tui-settings.ts`, `src/config/presentation.ts` |
| Pi settings reconciliation and file watching | `src/config/pi-settings-sync.ts`, `src/runtime/settings-watch.ts` |
| Value resolution, publication, reload decision | `src/runtime/settings.ts`, `src/runtime/apply.ts` |
| Keybinding bridge and effort actions | `src/runtime/actions.ts`, `src/runtime/effort.ts` |
| Editor session, fields, list editors, screen | `src/ui/` |

## Develop

Source: https://github.com/luan/agents, directory
harnesses/pi/agent/packages/pi-xsettings. Run `bun run typecheck` and
`bun test test` in that directory.
