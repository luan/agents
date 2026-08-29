# pi-side-chat

`pi-side-chat` owns independent interactive Pi sessions. `/side [prompt]` and
the `side-panel.chat.new` action always create a new UUID-scoped session under
the root session directory, or under temporary storage when the root runs with
`--no-session`; they never resume a session selected by display name. Each new
session forks the parent session's active model-visible history,
followed by the same hidden user-role side-conversation boundary that Codex
injects after a thread fork. `/side close` closes the active contributed tab.

When `pi-side-panel` is available, each chat is contributed as a `󱐒` tab. When
it is absent, the same PTY-backed Pi TUI opens in a fullscreen overlay. Both
surfaces preserve the child Pi session's native editor, cursor, tools, pointer
selection, shortcuts, and Escape behavior. `pi-libtui` owns the shared native
PTY lifecycle; side chat owns only its child sessions and presentation. The
package does not depend on the panel host or another feature extension.
Extension reloads retain each live child PTY, including unsent editor text. A
session switch or quit terminates the children. Without the panel host, the
newest persisted chat opens in the overlay; simultaneous restored chats require
the tabbed panel surface.

`alt+i` is configured in the managed `keybindings.json`, not this extension.

## Architecture

| Concern | Owner |
| --- | --- |
| Unique child session creation and resume commands | `src/session.ts` |
| Persisted chat identity | `src/state.ts` |
| PTY lifecycle, panel contribution, overlay fallback | `src/manager.ts` |
| Live PTY ownership transfer across extension reload | `src/process-registry.ts` |
| Command, action, and optional provider registration | `src/extension.ts` |

## Validate

```sh
bun run --cwd harnesses/pi/agent/packages/pi-side-chat typecheck
bun test harnesses/pi/agent/packages/pi-side-chat/test
just pi-install-check harnesses/pi/agent/packages/pi-side-chat
```
