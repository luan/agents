# pi-xsettings

`pi-xsettings` is the settings host for Pi extensions. It provides:

- the `/xsettings` editor;
- `xsettings.toml` persistence;
- the `pi-xsettings/sdk` API for typed extension settings; and
- the `keybindings.json` bridge for extension actions.

The package is also usable as a library. The SDK has no Pi extension, TUI, or
file-writing side effects.

## Install and open

```sh
pi install ./harnesses/pi/agent/packages/pi-xsettings
```

In the interactive TUI, run:

```text
/xsettings
```

The package also registers the `xsettings.toggle` action. The repository's
default `~/.pi/agent/keybindings.json` binds it to `ctrl+,`; the command still
works when the action has no key. Keybindings are read when extensions load, so
reload Pi after changing that file.

`/xsettings` requires the interactive TUI. Its left sidebar contains seven
pages: UI, UX, Animations, Terminal, Behavior, Interaction, and Tools.
Extension settings appear under the label supplied when the extension
registers them. Use `/` to filter the current page, arrow keys or `j`/`k` to
move, `h`/`l` or left/right to change pages, Tab/Shift+Tab to move between
sections, and Enter to edit. Reset removes the saved value and restores its
default.

## `xsettings.toml`

The active file is `~/.pi/agent/xsettings.toml`. This repository keeps its
managed copy at `harnesses/pi/agent/xsettings.toml`.

Persistence uses four category tables. Pi settings are stored under `pi`; extension
settings are stored under the extension namespace:

```toml
[appearance]
pi.theme = "tokyo-night"
pi-libtui.iconPack = "nerd-fonts"
pi-libtui.activityIndicator = "static"
pi-libtui.pulseEffect = "color"
pi-libtui.activityMessage = "phase"
pi-libtui.textEffect = "sweep"
pi-libtui.textEffectScope = "inline"
pi-libtui.statusPresentation = "standard"
pi-libtui.animationSpeed = "normal"
pi-libtui.animationSmoothness = "balanced"
pi-libtui.thinkingIndicator = "off"
pi-libtui.toolTextEffect = "lightning"
pi-libtui.toolPresentation = "block-wave"

[behavior]
pi-codex-native.cacheDiagnostics = "status"

[interaction]
pi.steeringMode = "one-at-a-time"

[tools]
pi.defaultTools = []
pi-exec-command.defaultOutputTokens = 20000
```

The four categories are fixed. Other top-level TOML tables are preserved but
are not shown in the editor. Unknown keys inside known tables are preserved as
well.

Pi's built-in tool setting has one useful distinction: an omitted
`pi.defaultTools` key means “use Pi's default tools”, while
`pi.defaultTools = []` explicitly disables all built-in tools.

Every confirmed edit writes the file immediately. Writes use a temporary file
and rename, and a managed symlink is followed rather than replaced. The writer
keeps unknown data but rewrites formatting; comments and the original layout
are not preserved. If the file does not exist, the host creates it with a
short comment.

## Live changes and reloads

The host publishes each saved extension value to its registered SDK client as
soon as it writes the TOML. The extension decides what to do with that value.

These settings apply live in the current TUI:

- `pi.theme`;
- `pi-libtui.iconPack`;
- `pi-libtui.activityIndicator` and `pi-libtui.activityMessage`;
- `pi-libtui.textEffect` and `pi-libtui.textEffectScope`;
- `pi-libtui.statusPresentation`;
- `pi-libtui.animationSpeed`;
- `pi-libtui.animationSmoothness`;
- `pi-libtui.thinkingIndicator`, `pi-libtui.thinkingMessage`, `pi-libtui.thinkingTextEffect`, and `pi-libtui.thinkingPresentation`;
- `pi-libtui.workingIndicator`, `pi-libtui.workingMessage`, `pi-libtui.workingTextEffect`, and `pi-libtui.workingPresentation`;
- `pi-libtui.toolIndicator`, `pi-libtui.toolMessage`, `pi-libtui.toolTextEffect`, and `pi-libtui.toolPresentation`;
- `pi-libtui.powerline`;
- `pi-libtui.powerlineButtons`; and
- `pi-libtui.softCursor`.

The shared motion settings are grouped under General on the Animations page.
Thinking, Working, and Tool sections override the request status animation and
inherit General by default;
tool-specific overrides use their tool name as a section. The indicator picker
renders every indicator with the configured text effect and scope. Whole-inline
scope paints the indicator, separator, and message as one unit. The text-effect
picker renders every effect with the configured indicator. The speed and
smoothness pickers animate every option with the production activity renderer;
smoothness previews each row at its own repaint cadence. The status-presentation
picker previews intentional compositions and exclusive scenes adapted from
`arpagon/pi-animations`; it defaults to standard and each request phase may inherit
or override it independently.

The indicator list keeps the original spinner and static choices and adds
curated one-to-four-cell Unicode, ASCII, Braille, and Nerd Font sequences. Arc
always uses its rounded Unicode positions; the Fira Code progress spinner is a
separate Nerd Font choice. Pulse and Color
pulse are independent effects that compose with every indicator and text effect;
Pulse changes brightness while Color pulse moves toward a contrasting hue. Text
effects keep the original sweep and rainbow choices, port oh-my-pi's
fixed-velocity cosine glow, and add rainbow glow plus
the fast-mode lightning strike and nine variants for every printable ASCII
character. The rainbow and Nerd Font icon markers adapt the MIT-licensed
`arpagon/pi-animations` effects. Nerd Font indicator choices fall back to compact
ASCII motion when the Nerd Fonts icon pack is not active.
The compact Braille catalog is adapted from
[`unicode-animations`](https://github.com/gunnargray-dev/unicode-animations)
and [`cli-loaders`](https://github.com/agilek/cli-loaders); the geometric
single-cell sequences come from [Unicode Spinner](https://unicode.framer.website/).

Other settings normally need a Pi reload because Pi reads many built-in
settings during startup. When `/xsettings` is opened from a command context,
the host reloads after saving. When the caller cannot reload the host, it tells
you to run `/reload`. A full process restart is also sufficient.

`pi-xsettings` mirrors recognized Pi settings into `~/.pi/agent/settings.json`
because Pi reads that file before it loads extensions. Keep bootstrap values
such as package loading, trust, telemetry, provider, and model configuration in
`settings.json`; they are not extension settings.

## Extension SDK

Feature packages should import the UI-free SDK, not the host extension:

```ts
import { createSettings } from "pi-xsettings/sdk";

const settings = createSettings({
  namespace: "pi-example",
  label: "Example",
  definitions: {
    enabled: {
      label: "Enabled",
      description: "Enable the example feature.",
      category: "behavior",
      page: "behavior",
      type: "boolean",
      default: true,
    },
    mode: {
      label: "Mode",
      description: "How the feature runs.",
      category: "behavior",
      type: "enum",
      default: "safe",
      options: [
        { value: "safe", label: "Safe", description: "Use conservative behavior." },
        { value: "fast", label: "Fast", description: "Prefer speed." },
      ],
    },
  },
});

const unregister = settings.register((values) => {
  // Apply values to the extension.
});
```

`createSettings()` returns:

- `defaults`, the compiled defaults;
- `get()`, a cloned current value; and
- `register(onValues)`, which returns an identity-safe disposer.

Supported setting types are `boolean`, `string`, `enum`, unordered or ordered
`multi-enum`, ordered `string-list`, and schema-checked ordered `list` values.
Use `stringListSetting()` for a list of strings with a minimum length. Use
`listSetting()` with a TypeBox schema and a declarative item definition for
structured records; xsettings supplies the editor and persistence.

Every definition names one of the four persistence categories. The optional
presentation-only `page` chooses UI, UX, Animations, Terminal, Behavior,
Interaction, or Tools without changing the TOML path. It defaults to the
matching category, with `appearance` shown on UI. An explicit definition
`section` becomes its heading within the page; otherwise the registration
`label` is used. Animation enums can declare the data-only `preview` kind
`activity-marker`, `activity-message`, `text-effect`, `status-presentation`, `animation-speed`, or
`animation-smoothness`; xsettings then previews global settings and
extension-owned inherited overrides with the production libtui renderer. The
namespace becomes the TOML owner key. The SDK
validates defaults and host-published values; invalid values fall back to the
compiled default, enum values resolve to valid options, and multi-enum values
drop stale choices.

An extension can register before `pi-xsettings` loads. The registry delivers
the current values when the host publishes them. When the host is absent,
registration is a no-op and the extension keeps its compiled defaults.

Do not create another per-extension JSON or TOML settings file, register a
settings component, or open a second settings screen.

## Actions and keybindings

Register an action through `pi-libactions/registry/v1`, then give it keys in
the user-owned `~/.pi/agent/keybindings.json`:

```json
{
  "xsettings.toggle": ["ctrl+,"]
}
```

`pi-xsettings` reads that file once when the extension loads and registers only
the configured keys. Invalid JSON, unknown key IDs, or an unbound action are
safe: the action remains available through its command or other UI, but no
shortcut is installed. Feature extensions do not assign default shortcuts.

`pi-xsettings` is the global shortcut host: it is the one package that
translates the validated action snapshot into Pi's `registerShortcut()` API.
Action owners still register only their namespaced action and remain usable
when this host is absent.

## Architecture

| Concern | Owner |
| --- | --- |
| Pi command, action, and lifecycle | `src/extension.ts` |
| UI-free typed client | `src/sdk.ts` |
| Cross-extension registry | `src/protocol/settings.ts` |
| TOML load, update, reset, and atomic write | `src/config/store.ts` |
| Pi definitions and `settings.json` mirror | `src/config/pi-settings.ts` |
| Value resolution and publication | `src/runtime/settings.ts` |
| Live application and reload decision | `src/runtime/apply.ts` |
| Keybinding bridge | `src/runtime/actions.ts` and `pi-libactions/sdk` |
| Settings fields and editors | `src/ui/fields.ts`, `src/ui/settings-editor.ts`, `src/ui/string-list-editor.ts`, and `src/ui/structured-list-editor.ts` |
| TUI screen | `src/ui/xsettings-screen.ts` |

## Troubleshooting

- **`/xsettings` says it needs the interactive TUI:** run it from Pi's TUI,
  not print, RPC, or another non-interactive mode.
- **A setting is not shown:** check its category, page, namespace, and key. The
  UI only shows registered definitions on the seven fixed pages.
- **A value resets immediately:** the TOML value failed the definition's type,
  option, minimum-length, or schema validation.
- **An extension did not react to a change:** xsettings publishes values
  immediately, but an extension may only read them at startup. Run `/reload`
  and check the extension's compiled default and namespace.
- **A shortcut does nothing:** inspect `~/.pi/agent/keybindings.json`, use a
  valid Pi key ID, and reload Pi after editing it. `/xsettings` remains
  available as a command.
- **Comments disappeared:** this is expected. The store preserves unknown
  values, not comments or the original TOML layout.
