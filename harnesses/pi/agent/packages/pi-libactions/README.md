# pi-libactions

`pi-libactions` is a UI-free action registry and keybinding loader for Pi
extensions. It is a library, not a Pi extension: importing it registers no
commands, shortcuts, tools, or UI.

The registry lets an extension publish an action without knowing which host
will expose it. `pi-xsettings` is the current global shortcut host. Modal
features such as `pi-copy-mode` can read the same keybinding snapshot without
registering their keys as global editor shortcuts.

## Install and import

This package is private to the repository. Add it as a workspace dependency
from another Pi package in the same repository:

```json
{
  "dependencies": {
    "pi-libactions": "workspace:*"
  }
}
```

Run `bun install` from the repository root, then import the public SDK:

```ts
import { registerAction } from "pi-libactions/sdk";
```

The package has no direct dependencies. It requires the Pi coding-agent and
TUI peer packages. It is not installed with `pi install` by itself; install a
Pi extension that depends on it.

## Action registry

The registry protocol is `pi-libactions/registry/v1`, stored at:

```ts
Symbol.for("pi-libactions/registry/v1")
```

An action has this shape:

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ActionRegistration = {
  id: string;
  description: string;
  run(ctx: ExtensionContext): void | Promise<void>;
};
```

Use a stable, namespaced ID. Register during extension setup and retain the
disposer for reload and shutdown:

```ts
import { registerAction } from "pi-libactions/sdk";

const unregister = registerAction({
  id: "example.open",
  description: "Open the example panel",
  async run(ctx) {
    await openExamplePanel(ctx);
  },
});

// Call when the extension is disposed or reloaded.
unregister();
```

`registerAction()` uses the process-wide registry returned by
`ensureActionsRegistry()`. A host that needs to inspect or listen to the
registry can use the full API:

```ts
import { ensureActionsRegistry } from "pi-libactions/sdk";

const actions = ensureActionsRegistry();
const stopListening = actions.onRegister((action) => {
  console.log(action.id, action.description);
});
const action = actions.find("example.open");
```

The registry also exposes `protocol` and `version` (`1`). `register()` and
`onRegister()` each return a disposer. `onRegister()` receives registrations
made after the listener is attached; it does not replay existing actions.
The registry never calls `run()` itself.

Registering an existing ID replaces its action. A disposer only removes the
exact action instance it registered, so disposing an older registration cannot
remove a newer replacement. Listener errors are swallowed so an optional host
cannot break registration. `registerAction()` also returns a no-op disposer if
the global capability cannot be created. The runtime registry does not validate
the fields of an action; callers must provide the documented shape.

Separate copies of this package in the same JavaScript realm find the same
registry through `Symbol.for`. `ensureActionsRegistry(scope)` accepts a custom
global-like object when a separate scope is required.

The SDK exports `ACTIONS_PROTOCOL`, `ACTIONS_REGISTRY_KEY`,
`ActionRegistration`, and `ActionsRegistry` in addition to the functions above.

## `keybindings.json`

`loadActionKeybindings(path?)` reads the user-owned keybinding file and returns
an immutable map from action ID to an ordered array of Pi key IDs. With no
argument, it reads:

```text
<Pi agent directory>/keybindings.json
```

For the normal local agent this is `~/.pi/agent/keybindings.json`.

The document is a JSON object. Each value is either one key ID or an array of
key IDs:

```json
{
  "example.open": "ctrl+o",
  "model-roles.select": ["alt+p", "f6"],
  "codex.context.cycle": "ctrl+shift+w"
}
```

Accepted base keys are lowercase letters, digits, punctuation, `escape`/`esc`,
`enter`/`return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`,
`home`, `end`, `pageUp`, `pageDown`, the four arrows, and `f1` through `f12`.
The optional modifiers are `ctrl`, `shift`, `alt`, and `super`. Modifiers must
be unique; a key ID is written as `modifier+base`, for example
`ctrl+shift+p`.

The loader preserves array order and does not resolve collisions between action
IDs. It filters invalid values and key IDs. An invalid entry remains in the
returned map with an empty array. A malformed JSON document, unreadable file,
or invalid top-level value returns `{}`. The outer map and every key array are
frozen. `isActionKeyId(value)` checks one key ID without reading a file. The
loader does not watch the file; call it again after a reload to get a new
snapshot.

The SDK exports `ActionKeybindings`, `isActionKeyId`, and
`loadActionKeybindings` for consumers that need the keybinding types or
validator directly.

## Consumers

- `pi-xsettings` loads the snapshot and exposes registered actions through
  `pi.registerShortcut()` for every configured key.
- `pi-copy-mode` reads the snapshot for its modal actions and entry action.
- `pi-model-roles` registers `model-roles.select`.
- `pi-codex-native` registers `codex.fast.toggle` and
  `codex.context.cycle`.

An action can be registered with no keybinding. The registry remains usable
without `pi-xsettings`; a missing shortcut host is simply a missing consumer.
