# pi-libtui

`pi-libtui` contains the shared terminal UI pieces used by this repository's
Pi extensions: layouts, dialogs, pickers, selection actions, semantic colors,
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
| `pi-libtui` | Common TUI components: layouts, dialogs, pickers, inputs, mounted selection actions, semantic colors, icons, cursors, `PointerInteractionController`, `RenderedLinesCache`, `SyntaxText`, and motion/progress | `pi-libtui` owns component and mounting mechanics; consumers own selection eligibility and action payloads | None; registries, appearance, and the shared motion scheduler initialize only when explicitly used | No for rendering; yes only for Pi-native bridges |
| `pi-libtui/diff` | `createUnifiedDiffModel`, `parseUnifiedDiff`, `renderUnifiedDiff`, `UnifiedDiffView`, and bounded diff models/viewports | Consumer supplies diff input and theme; `pi-libtui` owns parsing/rendering | None on import or render | No |
| `pi-libtui/editor` | `ensureEditorRegistry`, `dispatchEditorPaste`, `dispatchEditorRender`, `SemanticEditor`, `semanticEditorTheme`, and editor registry contracts | Editor host and feature packages share the registry | Explicit `ensureEditorRegistry` creates or reuses a process-global capability | Only to connect the registry to Pi's editor |
| `pi-libtui/folding` | `ensureFoldingRegistry`, `foldTargetAt`, `clearFoldingCurrent`, and fold-target contracts | Foldable feature owns targets; copy-mode host owns keyboard consumption | Explicit `ensureFoldingRegistry` creates or reuses a process-global capability | Only for host keyboard/copy-mode integration |
| `pi-libtui/mouse` | `ensureMouseRegistry`, `registerModalPointerShield`, viewport handlers, normalized pointer contracts, `getFullscreenLayoutCapability`, `publishFullscreenLayoutCapability`, and `resolveFullscreenLayout` | Generic host bridge dispatches; the Pi host publishes validated layout geometry; feature packages resolve it without knowing the host extension | Explicit `ensureMouseRegistry` creates or reuses a process-global capability; layout resolution only reads an existing host capability | Yes for terminal pointer events or Pi-private layout geometry |
| `pi-libtui/selection` | `ensureSelectionRegistry`, native selection geometry, completion events, and action contracts | Pi selection host publishes; feature packages subscribe/actions | Explicit `ensureSelectionRegistry` creates or reuses a process-global capability | Yes for Pi-native selection events |
| `pi-libtui/stream` | `BoundedStreamBuffer` and bounded UTF-8/ANSI-safe stream snapshots | Stream consumer owns lifecycle and view policy | None; instances are local state | No |
| `pi-libtui/terminal` | `TerminalProjection` and incremental `TerminalOutput` for bounded PTY/ANSI projection | Tool consumer supplies bytes, dimensions, and repaint callback | None on import; instances own emulator state | No; a TUI callback is supplied by the consumer |
| `pi-libtui/tool` | `ToolAction`, `LiveToolAction`, `ToolDisclosureAction`, `ToolActivity`, `ToolOutput`, `ToolTranscript`, `ToolViewRegion`, and tool-call preview helpers | `pi-libtui` owns generic presentation; feature packages own tool semantics | None on import; instances are local state | No for rendering |

The package manifest separately loads `src/extension.ts` as a Pi extension. That
entry point installs mouse, cursor, and editor bridges, terminal-color fallback
behavior, and the `/libtui:colors` diagnostic; it registers no model-facing tools,
shortcuts, or feature UI.
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
| Overlays | `src/overlay/anchored.ts`, `src/overlay/dialog.ts`, `src/overlay/fullscreen.ts`, `src/overlay/modal-mount.ts` |
| Actions and navigation | `src/controls/action-panel.ts`, `src/controls/dialog-button-bar.ts`, `src/controls/selection-action-bar.ts` (including fullscreen mounting), `src/controls/tab.ts` |
| Choices and fields | `src/controls/selectable-list.ts`, `src/controls/semantic-input.ts`, `src/controls/searchable-select.ts`, `src/controls/picker-panel.ts`, `src/controls/multi-select.ts` |
| Text content | `src/content/text.ts` |
| Glyphs, status, pills, and pointer interaction | `src/decoration/glyphs.ts`, `src/decoration/status.ts`, `src/decoration/editor-pills.ts`, `src/decoration/powerline-pill.ts`, `src/decoration/transient-pill.ts`, `src/decoration/pointer-interaction.ts` |
| Editor protocol and presentation | `src/editor/protocol.ts`, `src/editor/presentation.ts` (re-exported by `src/editor.ts`) |
| Syntax highlighting | `src/syntax.ts` |

These are implementation paths, not additional package exports. Consumers keep
using the documented package root and subpaths so the public API remains stable.

## Appearance settings

`pi-xsettings` owns the settings UI and persistence for the shared appearance:

- icon pack: `unicode`, `nerd-fonts`, or `emoji`;
- Powerline separators and Powerline button caps;
- softer virtual cursor;
- insertion, navigation, and selection cursor styles.

The compiled defaults are portable Unicode icons, flat separators/buttons, and
virtual cursors. If `pi-xsettings` is absent, components still use those
defaults. The settings can be changed live through `/xsettings` when its host
is installed.

## Architecture

| Responsibility | Owner |
| --- | --- |
| Tool definition | None; the package adds no model-facing tool |
| Execution owner | None in the library; `src/extension.ts` owns host setup |
| State owner | Components own local state; `MouseBridgeHost` owns host bridge state |
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
- `TuiForegroundToken` and `TuiBackgroundToken` name reusable roles.
- `TuiSwatch` selects one of the red, green, yellow, blue, magenta, cyan, or
  gray ramps at shade `0` through `5`.
- `TuiColor` is an opaque resolved handle used when a component must carry a
  color between operations without exposing RGB values or palette indexes.

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
