# pi-libcontext

`pi-libcontext` is the UI-free capability for optional Codex context-window
preferences. A contributor can publish a requested preset without importing
the provider that applies it. The provider decides what the preset means and
whether the current model supports it.

This is a library, not a Pi extension. It has no settings file, persistence,
commands, shortcuts, tools, or UI.

## Install and import

This package is private to the repository. Add it as a workspace dependency
from another Pi package in the same repository:

```json
{
  "dependencies": {
    "pi-libcontext": "workspace:*"
  }
}
```

Run `bun install` from the repository root, then import the public SDK:

```ts
import {
  CONTEXT_WINDOW_PRESETS,
  requestedContextWindowPreset,
  ensureContextWindowSourceRegistry,
  type ContextWindowPreset,
} from "pi-libcontext/sdk";
```

The package has no runtime dependencies. Its only peer dependency is Pi's
coding-agent package, which supplies the `ExtensionContext` type. It is not
installed with `pi install` by itself; install a Pi extension that depends on
it.

## Presets

`ContextWindowPreset` is one of these exact lowercase values, in increasing
size order:

```ts
const CONTEXT_WINDOW_PRESETS = ["smart", "balanced", "enhanced", "large", "max"] as const;
```

`ContextWindowPreference` adds `"default"` at the front:

```ts
const CONTEXT_WINDOW_PREFERENCES = [
  "default",
  "smart",
  "balanced",
  "enhanced",
  "large",
  "max",
] as const;
```

`default` means that the provider's own setting should win. It is a preference
value and is not returned by `requestedContextWindowPreset()`.

Use `isContextWindowPreset(value)` when validating an untyped value. It accepts
only the five values in `CONTEXT_WINDOW_PRESETS`; `default`, `undefined`, and
other strings are rejected.

## Source registry

The registry protocol is `pi-libcontext/sources/v1`, stored at:

```ts
Symbol.for("pi-libcontext/sources/v1")
```

A source has an ID and a function that derives a preset for the current Pi
context:

```ts
import { ensureContextWindowSourceRegistry, type ContextWindowPreset } from "pi-libcontext/sdk";

const unregister = ensureContextWindowSourceRegistry().register({
  id: "example",
  preset(_ctx): ContextWindowPreset | undefined {
    return "large";
  },
});

// Call when the contributing extension is disposed or reloaded.
unregister();
```

The registry exposes `protocol`, `version` (`1`), and `register()`. Registering
the same ID replaces the previous source. A disposer is identity-safe: it can
remove only the source instance that created it, so an old disposer cannot
remove a replacement. Separate copies of this package in the same JavaScript
realm share the registry through `Symbol.for`.

## Resolution and failure behavior

The provider asks for the current request with:

```ts
const requested = requestedContextWindowPreset(ctx);
```

Sources are checked in registry insertion order. The first source that returns
a valid preset wins. A source returning `undefined` or an invalid string is
ignored and resolution continues. If a source throws, the error is swallowed
and the next source is tried. If no source returns a valid preset, the function
returns `undefined`.

Registrations are owned by source object identity. Multiple active extension
instances may use the same descriptive `id`; unregistering one removes only
that registration and preserves the others.

The registry has no built-in default and does not apply a context window. It
only carries the optional request; the provider owns model eligibility,
numeric window sizes, fallback behavior, and any stronger provider-side
override. `ensureContextWindowSourceRegistry(scope)` accepts a custom
global-like object when a separate scope is required.

The SDK also exports `CONTEXT_WINDOW_SOURCES_KEY`,
`CONTEXT_WINDOW_SOURCES_PROTOCOL`, `ContextWindowSource`, and
`ContextWindowSourceRegistry` for hosts that need to inspect the versioned
capability directly.

## Consumers

- `pi-model-roles` registers the active role's optional context-window
  preference. A role using `default` contributes nothing.
- `pi-codex-native` reads the first valid request and applies it to eligible
  Codex models. Its session setting remains the fallback when no source makes
  a request.

Consumers should register and dispose their source with their extension
lifecycle. A missing provider is harmless: the source registry can still be
created and populated, while no package is required to own the other package's
private implementation.
