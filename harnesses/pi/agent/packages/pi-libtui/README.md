# pi-libtui

Shared terminal components for this repository's Pi extensions.

The package is a library, not a Pi extension. It registers no tools, commands,
shortcuts, hooks, or UI by itself.

## Components

- `FullscreenOverlay` covers the current terminal with a border through Pi's
  supported custom overlay API. It uses the terminal's default background.
- `TabBar` provides `h`/`l` and left/right navigation.
- `SearchableSelect` provides navigation-first single selection with optional
  `/` filtering.
- `MultiSelect` provides ordered or unordered selection, explicit save, and a
  warning before discarding changes.

Settings fields, defaults, persistence, sections, and screen composition
belong to `pi-xsettings`. Shared components accept only domain-free titles,
options, values, and callbacks.

## Architecture

```text
src/index.ts                  exports only
src/ui/fullscreen-overlay.ts  bordered terminal-sized overlay
src/ui/searchable-select.ts   searchable single selection
src/ui/multi-select.ts        ordered and unordered multi-selection
src/ui/tab-bar.ts             tab navigation and rendering
```

Consumers import the package normally. `pi-libtui` does not know which
extension uses a component.
