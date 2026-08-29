# pi-tuicr

`pi-tuicr` owns the review workflow. The `side-panel.tuicr.open` action opens a
review target picker. With `pi-side-panel` installed, reviews appear as ``
tabs and the active target remains a right-aligned dropdown on the tab row.
Without the host, the picker and the same full tuicr TUI open as overlays.

Review comments are watched from tuicr's session files rather than polled. They
appear live in Pi's editor as one ` N review comments` attachment. Its hover
detail uses the same reusable `pi-libtui` detail-card component as annotations.
The package passes the resolved light or dark appearance to tuicr so embedded
truecolor rendering does not rely on a terminal background query.

`ctrl+shift+g` is configured in the managed `keybindings.json`, not this
extension. `tuicr` must be available on `PATH`.

## Architecture

| Concern | Owner |
| --- | --- |
| Git target discovery, process launch, comments watcher | `src/tuicr-review.ts` |
| PTY lifecycle, panel contribution, overlay fallback | `src/manager.ts` |
| Editor attachment and shared hover detail | `src/review-comments.ts` |
| Action and optional provider registration | `src/extension.ts` |

## Validate

```sh
bun run --cwd harnesses/pi/agent/packages/pi-tuicr typecheck
bun test harnesses/pi/agent/packages/pi-tuicr/test
just pi-install-check harnesses/pi/agent/packages/pi-tuicr
```
