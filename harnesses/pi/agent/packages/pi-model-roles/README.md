# pi-model-roles

`pi-model-roles` gives Pi named profiles for model, thinking level, routing,
and optional context-window preferences. A role is an ordered list of model
candidates. The first candidate available in the current session that
supports its requested thinking level wins.

The package does not import or inspect a provider implementation. It resolves
the configured `provider/model` names against Pi's available model registry.

## Install

From the repository root:

```sh
just setup
pi install ./harnesses/pi/agent/packages/pi-model-roles
```

## Use a role

In Pi:

```text
/role                 open the role picker
/role balanced        select a named role
/role clear           return to the configured default role
```

The package also registers the `model-roles.select` action. It does not own a
default shortcut; this repository binds that action to `alt+p` in
`harnesses/pi/agent/keybindings.json`. Outside the TUI, use `/role NAME`.

The built-in catalogue is:

| Role | Model | Thinking | Intended use |
| --- | --- | --- | --- |
| `tiny` | GPT-5.6 Luna | `low` | Bounded mechanical work and narrow searches. |
| `smol` | GPT-5.6 Luna | `high` | Routine work that needs more reasoning. |
| `quick` | GPT-5.6 Sol | `low` | Small, time-sensitive tasks. |
| `balanced` | GPT-5.6 Sol | `medium` | Careful review and independent judgment. |
| `task` | GPT-5.6 Luna | `xhigh` | Sustained delegated implementation. |

The built-in session default is `balanced`. The built-in subagent default is
`task`.

## Configure roles

Open `/xsettings` and edit **Model Roles** in the Behavior category. The
settings namespace is `pi-model-roles` in `~/.pi/agent/xsettings.toml`:

```toml
[behavior]
pi-model-roles.defaultRole = "balanced"
pi-model-roles.subagentDefaultRole = "task"
```

The `Roles` list editor controls the complete catalogue. Each role has:

- `name`: starts with a letter, then letters, numbers, `.`, `_`, or `-`.
- `description`: text shown in the picker and settings.
- `color`: one of `gray`, `red`, `green`, `yellow`, `blue`, `magenta`, or
  `cyan`.
- `candidates`: at least one ordered fallback.

Each candidate has:

- `model`: a `provider/model-id` pair, such as
  `openai-codex/gpt-5.6-sol`;
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`;
- `serviceTier`: `standard` or `priority`;
- `contextWindow`: `default`, `smart`, `balanced`, `enhanced`, `large`, or
  `max`. Legacy candidates may omit it; new configurations should state it.

`contextWindow = "default"` follows the active provider's normal setting.
Codex Native consumes the other values through the versioned
`pi-libcontext` capability. `serviceTier = "priority"` is a request; a
provider may ignore it when unsupported.

## Fallback and session behavior

When a role is selected, candidates are tried in order. A candidate is usable
only if its model is available and supports the candidate's thinking level.
If the requested role cannot resolve, the configured default role is tried.
If no candidate works, the selection is cleared and Pi reports the error.

Role selection is stored as a versioned custom session entry. It survives
reload, resume, fork, clone, and tree navigation, but it does not become part
of model context. Manually selecting a model or thinking level clears the
active role because the session no longer matches its candidate.

The package keeps role selection session-local. On Pi versions without a
public session-only model setter, its compatibility shim prevents role
selection from rewriting Pi's global model and thinking defaults. Remove that
shim when Pi provides a per-session persistence API.

## Troubleshooting

- `Unknown model role`: check the exact role name in `/xsettings`; names are
  case-sensitive and must start with a letter.
- `No usable model candidate`: verify the provider is installed and signed in,
  the model is enabled, and the requested thinking level is supported. Add a
  fallback candidate if the model is optional.
- `No credentials for provider/model`: authenticate the provider or change the
  candidate to an available model. A role does not provide credentials.
- The picker does not open: use `/role NAME` in a non-TUI session. The picker
  requires Pi's interactive TUI.
- A role disappears after a manual model change: this is expected; manual
  model or thinking selection clears the role indicator.

## Architecture

| Concern | Owner |
| --- | --- |
| Pi registration and commands | `src/extension.ts` |
| Role schema, defaults, and candidate resolution | `src/core/catalog.ts` |
| Typed xsettings definitions | `src/config/settings.ts` via `pi-xsettings/sdk` |
| Session role selection | `src/runtime/selection.ts` |
| Applying roles and fallbacks | `src/runtime/roles.ts` |
| Session-only Pi compatibility | `src/runtime/session-only-defaults.ts` |
| Context-window capability | `src/contributions/context-window.ts` via `pi-libcontext/sdk` |
| Keyboard action | `src/contributions/actions.ts` via `pi-libactions/sdk` |
| TUI picker | `src/ui/role-picker.ts` using `pi-libtui` |
| UI-free public API | `src/sdk.ts` |

The package registers no tools and no provider payload hooks.

## Validate

```sh
cd harnesses/pi/agent/packages/pi-model-roles
bun run typecheck
bun test test
```

From the repository root, `just check` runs the package with the other Pi
packages.
