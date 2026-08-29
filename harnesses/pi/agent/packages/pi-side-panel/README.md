# pi-side-panel

`pi-side-panel` is the generic side-panel host. It owns split layout, focus,
pointer resizing, persisted width and tab order, draggable pill tabs, and the
top-right show and zoom controls. It contains no side-chat or review behavior.

The first width is 50% of the terminal. `ctrl+shift+b` toggles visibility,
`alt+]` moves focus between panes, `alt+h` and `alt+l` change tabs, and
`alt+shift+z` expands or restores the panel. These are actions registered by
the package and bindings owned by the managed `keybindings.json`; the extension
does not register default shortcuts.

Feature packages contribute tabs and empty-state actions through the optional
`pi-libtui` side-panel protocol. A contributor has no runtime dependency on
this package and must continue to work when the host is absent.

## Architecture

| Concern | Owner |
| --- | --- |
| Contribution protocol and content types | `pi-libtui` |
| Generic panel lifecycle and persisted layout | `src/controller.ts`, `src/state.ts` |
| Tabs, empty state, dropdown row, and focus routing | `src/view.ts` |
| Generic actions | `src/actions.ts` |
| Pi registration and top-right controls | `src/extension.ts` |

## Validate

```sh
bun run --cwd harnesses/pi/agent/packages/pi-side-panel typecheck
bun test harnesses/pi/agent/packages/pi-side-panel/test
just pi-install-check harnesses/pi/agent/packages/pi-side-panel
```
