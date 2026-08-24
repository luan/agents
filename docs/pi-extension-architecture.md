# Pi extension architecture

Use this architecture for every Pi extension in this repository.

The architecture defines module roles and dependency direction. It does not
require empty directories.

## Package surface

Every extension package has these root files:

```text
pi-<name>/
  package.json
  README.md
  src/
    extension.ts
    index.ts
  test/
```

`extension.ts` is the Pi composition root. It creates services and registers
tools, hooks, commands, and renderers. Keep behavior in focused modules.

`index.ts` is the supported library surface. It contains exports only. Export
only stable contracts that another package or test must use.

Each README contains an architecture map. The map names the tool definition,
execution owner, state owner, native boundary, presentation owner, and public
capabilities. State `Pi default ToolExecutionComponent` when Pi owns the TUI.

## Module roles

Add only the directories that the package needs:

```text
src/
  protocol/
  contributions/
  core/
  config/
  runtime/
  native/
  tools/
  ui/
```

- `protocol/` defines optional cross-extension capability contracts.
- `contributions/` registers this package with an optional capability.
- `core/` contains pure logic and domain types.
- `config/` reads and validates configuration.
- `runtime/` owns stateful orchestration and session lifecycle.
- `native/` talks to Rust binaries or external processes. It does not use Pi
  or TUI APIs.
- `tools/` contains model-facing Pi tool definitions.
- `ui/` contains extension-level TUI presentation.

Large multi-feature packages can use named feature directories such as
`provider/`, `compaction/`, and `diagnostics/`. Each feature follows the same
module roles.

## Tool modules

Give every tool a named directory:

```text
tools/
  <tool-name>/
    definition.ts
    execute.ts
    result.ts
    presentation.ts
```

- `definition.ts` owns the schema, description, and `promptGuidelines`.
- `execute.ts` performs the operation.
- `result.ts` creates model-visible results.
- `presentation.ts` owns `renderCall` and `renderResult`.

Combine files when the complete tool remains small. Keep the fixed ownership.
Omit `presentation.ts` when Pi owns the presentation. Record that choice in
the README architecture map.

## Presentation readiness

Every tool is presentation-ready before it adds a custom renderer.

Treat `AgentToolResult.details` as the presentation model. Define a named,
exported details type beside the tool result builder. The model must be:

- serializable as JSON;
- versioned with `version: 1`;
- identified with a stable `tool` field;
- explicit about running, completed, failed, or other domain status;
- bounded in item count and text size;
- free of credentials, functions, class instances, signals, and raw errors.

Preserve all useful normalized execution information. Include the normalized
arguments, timing, progress, identifiers, structured results, affected
resources, truncation metadata, and failure data that the tool already knows.
Prefer bounded rich records over summaries and counts. Omit information only
when it is secret, unsafe to serialize, redundant with an unchanged content
item, or impossible to bound.

Use the same details type for partial and final results. Populate
`onUpdate` only from real execution progress. Do not add timers or fake
progress for presentation.

Keep model-visible `content` separate from presentation-only `details`.
Build both in the tool's `result.ts`. A later `presentation.ts` must be able
to render the call arguments, partial state, final state, and failure state
without changing execution code.

Tool call arguments remain available through Pi's `renderCall` context. Also
put normalized arguments in final `details` when execution resolves aliases,
defaults, paths, generated identifiers, or other runtime meaning.

Keep Pi's default renderer until a custom renderer has user-visible value.
State the current renderer in the package README architecture map.

## Dependency direction

Dependencies point toward behavior and away from composition:

```text
extension -> tools, contributions, ui, runtime
tools -> runtime, core
contributions -> protocol, runtime
ui -> result types and view models
runtime -> native, config, core
protocol -> package-independent types only
core -> package-independent logic only
native -> process and wire APIs only
```

Execution code does not import TUI code. TUI code does not control execution.
Native clients do not import Pi. Avoid generic filenames when the package has
more than one domain.

Use schemas as both the runtime validator and the source of TypeScript setting
types. Do not maintain a string union beside hand-written equality checks.
Keep parsed JSON and TOML in a closed value type until schema validation.

Do not use `any`. Do not spread raw `unknown` through internal APIs. When an
external library forces an untyped boundary, give it a narrow named alias and
an adjacent `type-boundary:` comment naming the source and validator. Validate
at that boundary and return a concrete domain type.

Keep shared UI libraries domain-free. A component belongs in `pi-libtui` only
when it has a concrete reusable interaction contract that does not name
settings, tools, providers, or another feature domain. Keep feature
composition and semantics in the owning extension. Searchable single-select
and ordered or unordered multi-select are shared primitives; the settings
editor remains owned by `pi-xsettings`.

Feature UIs compose semantic `pi-libtui` components for tabs, selectable rows,
fields, and actions. Pointer parsing, hit geometry, hover, capture, and wheel
behavior stay inside `pi-libtui`; feature packages do not import mouse
contracts or register pointer regions for ordinary component interaction.

Before implementing a feature component, inspect the component inventory in
`pi-libtui/README.md`. Reuse a shared component when its interaction contract
fits. Add a domain-free primitive to `pi-libtui` when two feature packages need
the same interaction contract; do not move feature labels, state, actions, or
workflow into the shared library.

The `pi-libtui` web catalog is the executable component inventory. Every
reusable visual or structural API and every runtime `pi-libtui` import used by
a feature package must map to a catalog story. The catalog discovers all Pi
themes, compares any selected set, exhaustively renders each component's
relevant appearance modalities, and includes resting, selected, and hover
states. Its coverage test fails when a feature starts using an unrepresented
API.

`pi-libtui` is a deliberate dual-role exception at the package level: it is
also a Pi extension so generic TUI host compatibility can be installed as a
dependency. Its extension entry point activates reusable mouse, fullscreen,
and terminal-color compatibility; it must not register feature tools,
commands, shortcuts, or feature UI. Keep the library exports side-effect-free
so normal imports do not activate the host bridge or terminal probes.

## Colors and appearance

Extension-owned UI gets its colors from `tuiTheme(theme)`. Use semantic
foreground tokens (`text.primary`, `text.secondary`, `text.muted`, `accent`,
`info`, `positive`, `warning`, `negative`, `border`, and `heading`) and
semantic backgrounds (`surface.*`, `cursor.*`, `action.*`, and `badge.*`) by
meaning, not by their appearance in one theme. Use `action.*` for interactive
button surfaces and `badge.*` for non-interactive labels. Use generated
`swatch(hue, shade)` colors when several stable identities need distinct hues.

Feature packages do not use Pi's tool, message, thinking, markdown, syntax, or
other host color tokens directly. This rule has no feature-package exception:
even a renderer for an exact Pi-owned surface uses a semantic pi-libtui token.
When preserving a native Pi meaning matters, pi-libtui owns and resolves that
alias so future UI evolution stays behind one boundary.

Cursor shape follows the same ownership rule. Feature UI declares an
`insertion`, `navigation`, or `selection` role through `pi-libtui`.
`pi-libtui` resolves that role to virtual paint or the configured terminal
default, block, underline, or bar; it alone controls hardware visibility,
DECSCUSR sequences, and terminal restoration.

Pass Pi's `Theme` into shared components that accept it, and continue using its
non-color text attributes such as `bold` and `underline`. In feature rendering,
do not call `theme.fg`, `theme.bg`, `theme.getFgAnsi`, or `theme.getBgAnsi` to
style extension-owned concepts. Convert once with `tuiTheme(theme)` and keep
the feature's color vocabulary semantic.

Transcript decorations must compose with the background at their destination.
Use `contrastBackgroundColor`, `contrastingPillBackground`, or the component's
destination-background option instead of assuming a global message or badge
background. This prevents pills and inline markers from disappearing when a
theme maps multiple Pi surfaces to the same color.

Feature UI does not emit literal foreground or background SGR sequences, fixed
RGB values, or fixed 256-color indices. Raw terminal color sequences belong in
`pi-libtui` color generation, parsing, and compatibility code. Parsing or
preserving host-rendered SGR and emitting non-color terminal control sequences
are allowed at a documented low-level boundary.

`bun run lint:pi` enforces the color boundary and selected shared-component
boundaries across every Pi package source file. Run it before package tests;
do not suppress a finding in a feature package.

## Capability boundaries

An extension does not know that another extension exists.

Use integration mechanisms in this order:

1. Pi public APIs and lifecycle hooks.
2. Pi tool metadata such as `promptGuidelines`.
3. Provider request hooks for provider-native behavior.
4. A generic capability protocol when Pi has no suitable API.

A capability protocol:

- names a capability instead of a package;
- uses no runtime import from another extension;
- lets every package install and load alone;
- treats an absent capability as a no-op;
- works in either extension load order;
- uses a versioned structural contract;
- avoids realm-sensitive checks such as `instanceof Map`;
- returns an identity-safe disposer for reload;
- isolates optional capability failures;
- has behavior tests for standalone load, reversed load order, reload, and
  package removal.

Put the owner contract in `protocol/<capability>.ts`. Put a consumer's
registration in `contributions/<capability>.ts`. Do not create a general
`integrations/` directory. Do not import another extension's private source.

A deliberate public library entry point is not an optional capability. It may
be a normal package dependency when it is UI-free, independently loadable,
and versioned as part of the provider package. `pi-xsettings/sdk` is the
approved example. Feature packages must not import the xsettings extension,
runtime, persistence, or UI modules.

If a capability connects only two specific extensions, change the ownership
or merge the extensions.

## Settings

Register typed settings with `createSettings()` from `pi-xsettings/sdk`. The
SDK is the only feature-facing settings API; it owns the structural registry
boundary and runtime validation. A definition chooses one fixed persistence
category and may choose a presentation-only page. Changing the page never
moves its TOML path. The registration label is the extension's default section;
extensions do not add another navigation level.

Defaults come from the definition. Do not persist them just to make them
visible. Without the xsettings host, the package runs with those compiled
defaults. Do not create a per-extension JSON fallback. Resetting a setting
deletes its TOML key so future default changes can take effect.

Use `listSetting()` for ordered structured records. Describe item identity,
summary fields, scalar fields, nested lists, defaults, and minimum lengths in
the definition. Xsettings owns the editor, rendering, navigation, validation,
and persistence. Extensions must not register arbitrary settings components or
open a second settings overlay. Add a reusable xsettings setting kind when a
new data shape cannot be expressed by the existing kinds.

## Custom actions

Register extension actions through the structural `pi-actions/registry/v1`
capability. Use a stable namespaced action ID. Feature extensions do not call
`pi.registerShortcut` and do not assign default keys. The user-owned
`keybindings.json` file is the only source of custom action bindings.

An action remains available when no key is configured. Its owning extension
must install and load without `pi-xsettings`; a missing action host is a no-op,
not a reason to restore a hard-coded shortcut.

## Tests

Mirror source modules under `test/` when that improves navigation. Test
observable behavior and meaningful failure boundaries. Do not test directory
shape, implementation wiring, or type declarations.

Every refactor preserves behavior before it changes behavior. Run package
type checks and behavior tests after each package migration.
