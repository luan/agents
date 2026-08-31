# pi-libtui

`pi-libtui` contains the shared terminal UI pieces used by this repository's
Pi extensions: layouts, split panes, dialogs, pickers, selection actions, semantic colors,
icons, cursors, syntax highlighting, animated tool surfaces, streamed output,
diffs, terminal projection, and the protocols those pieces need.

It has two separate surfaces:

1. `import "pi-libtui"` is a side-effect-free library. Importing it does not
   start Pi, probe the terminal, register a tool, or install UI.
2. The package manifest also loads `src/extension.ts` as a Pi extension. That
   entry point installs the generic mouse, cursor, and editor-token bridges, detects terminal
   colors, provides the fallback for the bundled `harmonious` theme, and registers the
   `/libtui:colors` terminal-palette diagnostic. It registers no model-facing tools,
   shortcuts, or feature-specific UI.

This dual role lets feature packages share the host compatibility layer while
keeping their own behavior and settings.

## Install and load

This repository loads `packages/pi-libtui` directly from Pi's `settings.json`.
To load the package in another local Pi installation:

```sh
pi install ./harnesses/pi/agent/packages/pi-libtui
```

Feature packages can depend on it as a local package. Install the package when
you need the extension-side mouse/cursor bridge; importing the library alone
is enough for pure components, color helpers, and protocol types.

The package also exposes `themes/harmonious.json` through its Pi manifest. If
the terminal does not support the palette query required by that theme, the
extension uses Pi's detected light or dark theme as a safe fallback and keeps
the saved theme choice intact.

## Public modules

Every public entry point is a side-effect-free library import. The owner column
describes who supplies state or consumes the capability; “host required” means
that importing and using the module alone is insufficient for the corresponding
Pi-native behavior.

| Import path | Principal exports / capability | Owner | Import side effects | Host required |
| --- | --- | --- | --- | --- |
| `pi-libtui` | Common TUI components: layouts, split panes, side-panel contribution protocol, dialogs, pickers, inputs, mounted selection actions, semantic colors, icons, cursors, `PtyProcess`, `PtyPane`, `applyScrollbar`, `PointerInteractionController`, `RenderedLinesCache`, `SyntaxText`, and motion/progress | `pi-libtui` owns component and mounting mechanics; consumers own pane contents, selection eligibility, and action payloads | None; registries, appearance, and the shared motion scheduler initialize only when explicitly used | No for rendering; yes for panes and Pi-native bridges |
| `pi-libtui/diff` | `createUnifiedDiffModel`, `parseUnifiedDiff`, `renderUnifiedDiff`, `UnifiedDiffView`, and bounded diff models/viewports | Consumer supplies diff input and theme; `pi-libtui` owns parsing/rendering | None on import or render | No |
| `pi-libtui/editor` | `ensureEditorRegistry`, `dispatchEditorPaste`, `dispatchEditorRender`, `SemanticEditor`, `semanticEditorTheme`, and editor registry contracts | Editor host and feature packages share the registry | Explicit `ensureEditorRegistry` creates or reuses a process-global capability | Only to connect the registry to Pi's editor |
| `pi-libtui/folding` | `ensureFoldingRegistry`, `foldTargetAt`, `clearFoldingCurrent`, and fold-target contracts | Foldable feature owns targets; copy-mode host owns keyboard consumption | Explicit `ensureFoldingRegistry` creates or reuses a process-global capability | Only for host keyboard/copy-mode integration |
| `pi-libtui/mouse` | `ensureMouseRegistry`, `registerModalPointerShield`, viewport handlers, normalized pointer contracts, `getFullscreenLayoutCapability`, `publishFullscreenLayoutCapability`, and `resolveFullscreenLayout` | Generic host bridge dispatches; the Pi host publishes validated layout geometry; feature packages resolve it without knowing the host extension | Explicit `ensureMouseRegistry` creates or reuses a process-global capability; layout resolution only reads an existing host capability | Yes for terminal pointer events or Pi-private layout geometry |
| `pi-libtui/selection` | `ensureSelectionRegistry`, native selection geometry, completion events, and action contracts | Pi selection host publishes; feature packages subscribe/actions | Explicit `ensureSelectionRegistry` creates or reuses a process-global capability | Yes for Pi-native selection events |
| `pi-libtui/stream` | `BoundedStreamBuffer` and bounded UTF-8/ANSI-safe stream snapshots | Stream consumer owns lifecycle and view policy | None; instances are local state | No |
| `pi-libtui/terminal` | `TerminalProjection` and incremental `TerminalOutput` for bounded PTY/ANSI projection | Tool consumer supplies bytes, dimensions, and repaint callback | None on import; instances own emulator state | No; a TUI callback is supplied by the consumer |
| `pi-libtui/tool` | `ToolAction`, `LiveToolAction`, `ToolDisclosureAction`, `ToolActivity`, `ToolOutput`, `ToolTranscript`, `ToolViewRegion`, and tool-call preview helpers | `pi-libtui` owns generic presentation; feature packages own tool semantics | None on import; instances are local state | No for rendering |

The package manifest separately loads `src/extension.ts` as a Pi extension. That
entry point installs mouse, cursor, editor, and shared native PTY compatibility,
terminal-color fallback behavior, and the `/libtui:colors` diagnostic; it
registers no model-facing tools, shortcuts, or feature UI.
Importing any table entry does not load or invoke that extension.

Tool presentation has three deliberate layers. `ToolTranscript` is the small
copy-friendly action-plus-payload wrapper. `ToolActivity` composes streaming,
diff, terminal, and viewport state for a live tool surface. Feature packages
compose these generic pieces for their own tool grammar. `ToolOutput` handles text streams, while
`TerminalOutput` and `TerminalProjection` handle PTY/ANSI state.
`pi-libtui/tool` is the only tool-presentation API. The package root owns
general components and does not duplicate the tool surface.

`SyntaxText` and diff rendering use the shared Pierre/Shiki highlighter.
Feature packages such as `pi-exec-command` compose shell-specific presentation
from that generic syntax surface.
Semantic Markdown text continues to use Pi's native `highlightCode` callback so
that Markdown rendering retains its host-provided theme and token behavior.

The root library surface keeps these implementation boundaries:

| Capability | Implementation modules |
| --- | --- |
| Layout and rendering infrastructure | `src/background-surface.ts`, `src/component-stack.ts`, `src/line-layout.ts`, `src/render-cache.ts`, `src/scrollbar.ts` |
| Fullscreen split panes | `src/split-pane.ts` and `src/host/split-pane-bridge.ts` |
| Side-panel contribution protocol | `src/side-panel.ts` |
| Overlays | `src/overlay/anchored.ts`, `src/overlay/dialog.ts`, `src/overlay/floating.ts`, `src/overlay/fullscreen.ts`, `src/overlay/hover-tooltip.ts`, `src/overlay/modal-mount.ts` |
| Actions and navigation | `src/controls/action-panel.ts`, `src/controls/dialog-button-bar.ts`, `src/controls/screen-icon-actions.ts`, `src/controls/selection-action-bar.ts` (including fullscreen mounting), `src/controls/tab.ts` |
| Choices and fields | `src/controls/selectable-list.ts`, `src/controls/semantic-input.ts`, `src/controls/searchable-select.ts`, `src/controls/picker-panel.ts`, `src/controls/multi-select.ts` |
| Text content | `src/content/text.ts` |
| Glyphs, status, pills, and pointer interaction | `src/decoration/glyphs.ts`, `src/decoration/status.ts`, `src/decoration/editor-pills.ts`, `src/decoration/powerline-pill.ts`, `src/decoration/transient-pill.ts`, `src/decoration/pointer-interaction.ts` |
| Editor protocol and presentation | `src/editor/protocol.ts`, `src/editor/presentation.ts`, `src/editor/chrome.ts`, `src/editor/composition.ts`, and `src/editor/layout.ts` (re-exported by `src/editor.ts`) |
| Syntax highlighting | `src/syntax.ts` |
| Shared native PTY lifecycle | `src/terminal/bridge-client.ts`, `src/terminal/pty-host.ts`, and `src/terminal/pty-pane.ts` |

The extension host keeps the shared PTY host alive across an extension reload
so feature-owned process leases can reattach without losing terminal state. A
session switch or quit shuts the host down.

These are implementation paths, not additional package exports. Consumers keep
using the documented package root and subpaths so the public API remains stable.

## Fullscreen split panes

`mountSplitPane()` composes one extension-owned pane beside Pi's complete
fullscreen layout. Pi's transcript, editor, widgets, status, and footer remain
inside the main pane and reflow to its allocated width. The most recently
mounted contribution is visible; disposing it restores the previous
contribution, or Pi's unwrapped layout when none remains.

```ts
const unmount = mountSplitPane({
	id: "example.details",
	position: "right",
	size: 32,
	initialRatio: 0.4,
	minMainSize: 1,
	priority: 10,
	onResize: (size) => saveCommittedWidth(size),
	component: (host, theme) => new DetailsPane(host, theme),
});
```

The pane and Pi's main surface are separated by a semantic vertical border.
Drag that border with the primary mouse button across all available terminal
space; Pi retains only the contribution's `minMainSize`. The preferred width
survives temporary pane replacement within the session. The pane hides when
the terminal cannot fit one pane cell, its border and gap, and the minimum main size.
`initialRatio` derives the first width from the terminal when the contribution
has no restored cell width. `onResize` runs once when a pointer drag commits so
the owning feature can persist that width without coupling persistence to the
shared geometry host.
Components whose input becomes visible only after asynchronous output may implement
`defersInputRender()`. The host then skips Pi's unchanged post-input frame and paints
when the component requests its output frame; synchronous components retain Pi's
normal immediate repaint.
It is available only in fullscreen mode. Protocol v2 selects the highest-priority
contribution and uses the latest mount to break ties. A pane factory receives the
active `tui`, allocated pane viewport-size and render-request access, plus
`focus()`, `blur()`, and `isFocused()`. Focus captures Pi's current component and restores it only
while the pane still owns focus, so an overlay or another component that takes
focus is not displaced. Clicking either pane focuses it without consuming the
click, preserving native selection and component behavior. Contributed
`ScrollView` layout nodes remain visible to Pi's native selection engine. Input
and mouse events are safely forwarded through the host wrapper to the
contributed component. `pi-libtui` owns layout composition, focus restoration,
and cleanup.

Pi 0.84.x exposes `setLayoutRoot()` but no layout-root getter. The extension
host therefore reads and validates that one private field, and guards focus
capture through `getFocusedComponent()` when that method is present. Its
prototype patch uses a versioned, ref-counted lease. If the expected shape is
absent, the bridge leaves Pi's layout unchanged. Regular rendering, and imports
of the side-effect-free library surface, are never patched.

## Appearance settings

`pi-xsettings` owns the settings UI and persistence for the shared appearance:

- icon pack: `unicode`, `nerd-fonts`, or `emoji`;
- activity indicator: off, spinner, and static plus curated one-to-four-cell Unicode, ASCII, Braille, and Nerd Font animations;
- activity message: the request phase or rotating typewriter text;
- text effect: `off`, `sweep`, cosine `glow`, `rainbow`, `rainbow-glow`, `lightning`, `aurora`, `glitch`, or `crush`;
- pulse effects: independent dim-to-bright or contrasting-color motion composed over any indicator and text effect without changing glyph shape;
- text-effect scope: the message alone or the whole indicator, separator, and message unit;
- status presentation: standard inline composition, mixed compositions such as `brainstorm`, or exclusive scenes adapted from `arpagon/pi-animations`;
- animation speed: `slow`, `relaxed`, `normal`, `fast`, or `very-fast`;
- animation smoothness: `economy`, `balanced`, `smooth`, or `ultra` terminal redraws;
- independent indicator, message, text-effect, and presentation overrides for Thinking, Working, and Tool request phases;
- Powerline separators and Powerline button caps;
- softer virtual cursor;
- insertion, navigation, and selection cursor styles.

The compiled defaults are portable Unicode icons, a Braille spinner, the phase
message, no text effect, standard inline presentation, normal-speed balanced
animation, flat separators/buttons, and virtual cursors. Inline activity is
composed as `indicator + message`, then the selected effect scope is painted.
An exclusive scene replaces that composition. Static activity allocates no
timer. If `pi-xsettings` is absent, components use the compiled defaults. The settings can be changed live
through `/xsettings` when its host is installed.

Speed scales the animation timeline. Smoothness independently caps the shared
repaint frequency, from roughly 13 redraws per second in economy mode to 60 in
ultra mode. Balanced matches oh-my-pi's 30fps animated loader. Text effects use a
continuous elapsed-time timeline, while discrete indicators retain their designed
pace. The scheduler uses deadline-corrected one-shot timers, skips missed ticks,
and lets Pi coalesce and backpressure the actual terminal paints.

The extension entry point applies the same renderer to Pi's streaming status
row through public lifecycle and UI APIs. Thinking takes priority over Tool,
which takes priority over Working; parallel tool calls are tracked independently.
Each phase inherits General by default and can override its indicator, message,
text effect, or status presentation without changing extension-owned activity
surfaces.

Feature surfaces may pass one `ActivityAnimationOverrides` value to both
`activityFrame()` and `mountConfiguredAnimation()`. Omitted fields inherit the
live global appearance; explicit fields affect only that surface. Sharing the
same value keeps visible frames and scheduler cadence aligned, including the
fully static indicator-off and text-effect-off case.

Lightning retains `main`'s exact `z`/`i`/`n`/`g` variants and supplies the same
nine artifact families for every other printable ASCII character. Marker and
text characters change variants while its strike travels backward through the
complete activity unit.

Compact indicator frames retain a fixed width within each style so activity text
does not shift. Nerd Font indicator styles use their icon frames when the Nerd
Fonts icon pack is active and fall back to an ASCII line animation otherwise.
Arc always uses its six rounded Unicode positions. The Fira Code progress
spinner is a separate Nerd Font-only choice. The compact Braille catalog is
adapted from
[`unicode-animations`](https://github.com/gunnargray-dev/unicode-animations) and
[`cli-loaders`](https://github.com/agilek/cli-loaders); the geometric single-cell
sequences come from [Unicode Spinner](https://unicode.framer.website/).

## Architecture

| Responsibility | Owner |
| --- | --- |
| Tool definition | None; the package adds no model-facing tool |
| Execution owner | None in the library; `src/extension.ts` owns host setup |
| State owner | Components own local state; `MouseBridgeHost` owns host bridge state; `RequestAnimationController` owns active request phase state |
| Library surface | `src/index.ts`, `src/overlay/`, `src/controls/`, `src/content/`, `src/decoration/`, `src/editor.ts`, `src/syntax.ts`, `src/color/theme.ts`, `src/tool/`, and the public subpaths; `src/color/palette.ts` and `src/color/resolver.ts` remain internal color helpers |
| Extension host | `src/extension.ts` and `src/host/` |
| Shared contracts | `src/editor/protocol.ts` through the `src/editor.ts` facade, `src/folding.ts`, `src/selection.ts`, `src/decoration/pointer-interaction.ts`, and the explicit public contracts selected by `src/mouse.ts`; mutable mouse registry storage remains host-internal |
| Native boundary | TUI mouse/cursor compatibility, terminal color queries, and host bridges |
| Presentation owner | `src/background-surface.ts`, `src/component-stack.ts`, `src/line-layout.ts`, `src/render-cache.ts`, `src/scrollbar.ts`, `src/overlay/`, `src/controls/`, `src/content/`, `src/decoration/`, `src/editor/presentation.ts`, `src/syntax.ts`, `src/color/theme.ts`, `src/tool/`, motion, and semantic renderers |
| Stream and terminal projection | `src/stream.ts` and `src/terminal/` |
| Diff models and rendering | `src/diff/` |
| Public capabilities | `src/index.ts` and the documented `pi-libtui/*` subpaths |

The extension host knows only generic TUI mechanics. Feature labels, settings,
actions, and workflows stay in their owning packages. A consumer can import
the library without loading the host bridge.

Color resolution has one internal value path. `theme.ts` owns the complete
semantic-token table and resolves every paint through `resolver.ts`, which maps
the direct palette index or measured RGB value to the active terminal's RGB,
ANSI, or contrast output. Opaque `TuiColor` values retain either a semantic
token reference or a direct value: semantic handles are re-resolved by the
consuming theme, while palette indexes use its active palette and exact
measured RGB values remain exact. `TuiTheme.color()` creates handles;
`fg()`/`bg()` and `fgAnsi()`/`bgAnsi()` are the only paint operations.

Feature code uses only the root color API:

- `tuiTheme(theme)` creates the semantic facade.
- `createTuiThemeVariation(theme, name)` creates a complete, non-persisted Pi
  theme document with related but shifted surfaces for an adjacent full TUI.
- `tuiThemeAppearance(theme)` resolves the active surface to `dark` or `light`
  for an embedded application that cannot query the outer terminal background.
- `TuiForegroundToken` and `TuiBackgroundToken` name reusable roles.
- `TuiSwatch` selects one of the red, green, yellow, blue, magenta, cyan, or
  gray ramps at shade `0` through `5`.
- `TuiColor` is an opaque resolved handle used when a component must carry a
  color between operations without exposing RGB values or palette indexes.
- `TuiTheme.mixForeground()` interpolates semantic foreground paints through
  the active terminal color policy for smooth motion without leaking raw RGB.

`TabBar` renders semantic pill tabs with semantic or explicit glyph icons plus
an optional close affordance with independent hit geometry and pointer drag
reordering. Close hover changes only the glyph foreground so the tab pill stays
stable.
`mountScreenIconActions()` places dynamic icon-only actions at the top-right of
the complete screen. It owns pointer hit regions, hover paint, activation, and
borderless dim-pill tooltips with configured key hints while leaving action
registration to the feature package. `mountHoverTooltip()` supplies that same
compact behavior. `mountHoverDetailCard()` supplies reusable structured hover
content for annotation-like attachments. `DialogButtonBar` supports start,
center, and end-aligned button groups.

`src/color/palette.ts`, `src/color/resolver.ts`, and `src/terminal-colors.ts`
are terminal-boundary implementation. The exact 6×6×6 color256 coordinates,
generated RGB palette, ANSI parsing, and terminal measurements do not belong in
feature-package APIs.

## Troubleshooting

- If a feature renders but clicks do not work, install/load `pi-libtui` as a
  Pi package so the extension-side bridge is active. Components do not install
  pointer regions by themselves.
- If Nerd Font or Powerline glyphs are missing, switch the icon pack to
  `unicode` and disable Powerline in `/xsettings`. Those are also the fallback
  defaults when no settings host is present.
Run package checks from the package directory:

```sh
bun run typecheck
bun test test
```
