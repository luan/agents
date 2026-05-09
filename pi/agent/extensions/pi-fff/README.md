# pi-fff

Local Pi adapter for upstream FFF.

Keep upstream search/indexing code in the package dependency:

- `@ff-labs/fff-node` provides the native FFF backend.
- This directory owns only Pi-specific glue: tool registration, safe native runtime staging, TUI rendering, and `@file` autocomplete.

Do not copy `@ff-labs/pi-fff` source into this repo. To pick up upstream FFF fixes, update the dependency instead:

```sh
bun update @ff-labs/fff-node
bun test pi/agent/extensions/pi-fff/index.test.ts
```
