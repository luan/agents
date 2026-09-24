# @luan.sh/pi-custom-editor&nbsp;[<img src="https://pi.luan.sh/icons/pi.svg" width="14" alt="Pi gallery">](https://pi.dev/packages/@luan.sh/pi-custom-editor)&nbsp;[<img src="https://pi.luan.sh/icons/npm.svg" width="14" alt="npm">](https://www.npmjs.com/package/@luan.sh/pi-custom-editor)

A Pi extension that replaces the built-in input editor chrome and footer with a
configurable composition: semantic surfaces, top and bottom rules, left and
right rails, a prompt marker, and four status quadrants showing path, git
branch, model, thinking level, context usage, cost, and more. It keeps Pi's
native input rows, cursor, and autocomplete output and only re-draws the chrome
around them. It also highlights `@file` references and slash commands as you
type.

## Preview

![@luan.sh/pi-custom-editor in Bootty](https://pi.luan.sh/media/previews/pi-custom-editor-35442b4cbba0.png)

[Watch the demo](https://pi.luan.sh/media/previews/pi-custom-editor-08e00ee47814.mp4).

## Install

```sh
pi install npm:@luan.sh/pi-custom-editor
```

The extension is active in the TUI on the next session start. No configuration
is required; the `compact-field` preset is used until you change it.

Optional companion: `pi install npm:@luan.sh/pi-xsettings` adds the
`/xsettings` command with a live preview UI for every setting listed below;
without it the defaults apply and there is no in-app way to change them.

## What it does

- Wraps the editor through Pi's `setEditorComponent` layer. If another
  extension already installed an editor factory, that editor is decorated
  (its render output is re-composed) rather than replaced.
- Replaces the footer through Pi's `setFooter` with a status row driven by the
  same composition settings.
- Reads Pi's git branch, session name, model, provider, thinking level,
  context-window usage, per-session token/cost totals, and extension
  `setStatus` entries for status segments.
- Hides Pi's native "working" transcript row only when `workingPlacement` is
  set to something other than `transcript`; the original visibility is restored
  on session shutdown.
- Follows the shared appearance settings (animation speed, smoothness, reduced
  motion) provided by the bundled `@luan.sh/pi-libtui` runtime.

### Presets

`claude-code`, `pi`, `borderless`, `top-rule`, `minimal-field`,
`compact-field`, `full-field`, `status-band`. A preset fixes surface,
top/bottom treatment, rails, prompt marker, bottom status row, separator, band
style, and the segments in each quadrant. Every explicit control below defaults
to `preset`, meaning "inherit from the selected preset"; setting it to any other
value overrides only that piece.

### Status segments

Any of these can be placed, in order, in each quadrant when
`segmentSource` is `custom`:

`provider`, `model`, `thinking`, `fast`, `path`, `git`, `session`, `elapsed`,
`context`, `context-window`, `context-qualifier`, `tokens`, `cost`, `statuses`,
`clock`.

Segments that have nothing to show (no branch, thinking off, zero cost) are
omitted. `context` renders a gauge with percent used, tokens/window, and the
session's input/output totals and cost. `statuses` renders every extension's
`ctx.ui.setStatus(key, text)` entry, sorted by key like Pi's built-in footer,
so any extension can contribute to a quadrant without depending on this
package. Every preset places it right after `context`. The `working` segment
is not chosen directly; it is inserted by `workingPlacement`.

### Editor highlights

Two built-in contributions run on the rendered editor text:

- `@path` and `@"quoted path"` references (resolved against the current
  working directory, with `~` expansion) render as a pill with a
  filetype-aware Nerd Font icon. Existing paths use the positive tone, missing
  paths the negative tone. A token stays plain text while the cursor is inside
  it or not yet separated from it by whitespace.
- A leading `/command` on the first prompt line is positive if it is a Pi
  built-in or a registered extension command, otherwise negative.

Nothing is highlighted inside inline or fenced Markdown code.

## Settings

Settings are defined with `@luan.sh/pi-xsettings` under namespace
`@luan.sh/pi-custom-editor` (label "Custom Editor", page "Editor", applied live). Edit
them with `/xsettings` when `@luan.sh/pi-xsettings` is installed; otherwise the
defaults below apply.

| Key | Default | Values |
| --- | --- | --- |
| `preset` | `compact-field` | one of the presets above |
| `surface` | `preset` | `transparent`, `base`, `editor`, `raised`, `inset`, `accent` |
| `topTreatment` | `preset` | `none`, `half-block`, `rule`, `status-band` |
| `bottomTreatment` | `preset` | `none`, `rule` |
| `leftRail` | `preset` | `off`, `static`, `animated` |
| `rightRail` | `preset` | `off`, `static`, `animated` |
| `promptMarker` | `preset` | `none`, `angle`, `angleDouble`, `arrowHeavy`, `triangleFilled`, `triangleOutline`, `angleHeavy`, `angleWide`, `chevronOpen`, `chevronLight`, `chevronMedium`, `chevron`, `chevronHeavy`, `nfChevron`, `nfDoubleChevron`, `nfCircle`, `nfTerminal`, `nfPrompt` |
| `railTone` | `accent` | `accent`, `border` (color of rails at rest) |
| `footer` | `preset` | `off`, `on` (bottom status row, independent of the bottom rule) |
| `segmentSource` | `preset` | `preset`, `custom` |
| `workingPlacement` | `transcript` | `transcript`, `hidden`, `top-left-start`, `top-left-end`, `top-right-start`, `top-right-end`, `bottom-left-start`, `bottom-left-end`, `bottom-right-start`, `bottom-right-end` |
| `topLeftSegments` | `[]` | ordered list of segment ids |
| `topRightSegments` | `["path", "git", "model", "thinking", "fast"]` | ordered list of segment ids |
| `bottomLeftSegments` | `[]` | ordered list of segment ids |
| `bottomRightSegments` | `["context"]` | ordered list of segment ids |
| `statusSeparator` | `preset` | `space`, `dot`, `chevron`, `powerline` |
| `statusBand` | `preset` | `transparent`, `filled`, `powerline` |

The four segment lists are only used when `segmentSource` is `custom`. The
working indicator's marker, message, and animation are owned by the shared
Animations → Working settings; this package only decides where it is placed.

## Keybindings

This package registers no actions, commands, or keybindings.

## Highlight API

Other extensions can add editor highlights through a process-wide, versioned
registry. Import from `@luan.sh/pi-custom-editor`:

```ts
import { ensureEditorHighlightRegistry } from "@luan.sh/pi-custom-editor";

const registry = ensureEditorHighlightRegistry(); // protocol "pi-custom-editor/highlights/v1"
const dispose = registry.register({
  id: "my-extension.tickets",
  priority: 10,
  matches({ text }) {
    return [...text.matchAll(/\b[A-Z]+-\d+\b/g)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
      presentation: { kind: "foreground", color: "accent" },
    }));
  },
});
```

`matches` receives `{ text, line, promptLine, excludedRanges }` and returns
`{ start, end, presentation }` entries with UTF-16 offsets into `text`.
`presentation` is either `{ kind: "foreground", color }` or
`{ kind: "pill", label, icon, foreground?, iconTone?, minimumCursorGap? }`.
Contributions are applied in descending `priority`; overlapping matches from
lower-priority contributions and matches inside `excludedRanges` (Markdown
code) are dropped. Registering the same `id` again replaces the earlier
contribution; the returned function unregisters it. The registry is stored on
`globalThis` under `Symbol.for("pi-custom-editor/highlights/v1")`, so it
survives extension reloads and works across separately loaded extensions.

The package also exports `TuiState`, `WorkingSnapshot`, and `formatDuration`
(formats milliseconds as `12s`, `1m05s`, or `1h02m`).

## Layout

| Responsibility | File |
| --- | --- |
| Extension entry, lifecycle events, motion scheduling | `src/extension.ts` |
| Settings definitions and defaults | `src/config/settings.ts` |
| Presets, segment ids, preset resolution | `src/core/composition.ts` |
| Editor layer and composition rendering | `src/ui/pi-custom-editor.ts` |
| Footer component | `src/ui/footer.ts` |
| Status segment rendering | `src/ui/status.ts` |
| Working-time state | `src/runtime/state.ts` |
| Highlight registry protocol | `src/protocol/highlights.ts` |
| Highlight matching and validation | `src/core/highlights.ts` |
| Highlight painting onto editor lines | `src/ui/highlights.ts` |
| Built-in `@file` and `/command` highlights | `src/contributions/default-highlights.ts` |
| Filetype icons | `src/core/file-icons.ts` |
| Public exports | `src/index.ts` |

## Develop

Source: https://github.com/luan/agents, directory
harnesses/pi/agent/packages/pi-custom-editor. Run `bun run typecheck` and
`bun test test` in that directory.
