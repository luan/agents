# pi-codex-native

`pi-codex-native` adds the `openai-codex` provider to Pi. It talks
to the ChatGPT-backed Codex Responses endpoint, keeps the provider's native
request and response format, and registers the `web__run` tool.

It is an OpenAI Codex subscription provider (ChatGPT Plus/Pro). It is not a
general OpenAI API adapter, and it does not add shell, file, Code Mode, MCP,
or image-generation tools.

Upstream attribution for the ported transport and conversion code is in
`UPSTREAM.md`.

## Preview

![pi-codex-native in Bootty](https://github.com/luan/agents/releases/download/v0.3.2/pi-codex-native.png)

[Watch the demo](https://github.com/luan/agents/releases/download/v0.3.2/pi-codex-native.mp4).

## Install

```sh
pi install npm:pi-codex-native
```

Optional companions:

- `pi install npm:pi-xsettings` adds the `/xsettings` UI for the
  settings below and binds the package's actions to keys from
  `keybindings.json`. Without it, compiled defaults apply and no keys are
  bound.
- `pi install npm:@cfcluan/pi-code-mode` exposes `web__run` inside Code Mode
  scripts as well as directly. Without it, `web__run` is only a direct tool.

## Sign in and use

Start Pi and choose an `openai-codex/...` model. Pi asks this provider to log
in the first time. The provider offers:

- Browser login, using a local OAuth callback at
  `http://localhost:1455/auth/callback`. You can also paste the
  authorization code or redirect URL into the prompt.
- Device-code login for a headless machine (15-minute code lifetime).

Pi stores the OAuth credential in its normal auth store and refreshes it when
needed. Check the provider without starting a session with:

```sh
pi auth check --provider openai-codex
```

The package provides these models:

| Model | Input | Notes |
| --- | --- | --- |
| `gpt-5.3-codex-spark` | Text | 128k context. |
| `gpt-5.4` | Text, images | Tool search. |
| `gpt-5.4-mini` | Text, images | Tool search. |
| `gpt-5.5` | Text, images | Tool search. |
| `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` | Text, images | Additional tools, tool search, reasoning through `max`. |
| `gpt-6-astra` | Text, images | Same as GPT-5.6; cost estimates are zero until verified pricing is available. |

All models default to a 272k context window (128k for Spark) and 128k max
output tokens. GPT-5.6 models and GPT-6 Astra use the context presets below.

Use a model explicitly when needed:

```sh
pi --model openai-codex/gpt-5.6-luna
```

## Persistent mode

Choose **Reasoning mode (this session) → Persistent** in Codex Native settings.
Astra delivers answers while continuing useful authorized follow-up, including
waiting for results. **Use Pi thinking level** restores ordinary operation.
The selection applies immediately and is saved with the session, including forks
and resume. Other sessions keep their own selection.

The provider uses Astra's catalog instructions, Codex's fallback for other models,
and the `disabled` API effort value for Persistent. Instruction changes and UTC
reminders are recorded with the session and replayed at their original boundaries.
Pi continues to own execution, cancellation, and session history.

**Current time reminders** defaults to **Auto**, which enables them with Persistent.
**On** enables reminders independently; **Off** stops new reminders. Set the interval
in whole seconds; **0** allows a reminder before every eligible inference. Delivery
can be **Any inference** or **After user or tool output**. New context windows receive
an initial reminder regardless of the interval.

Async questions, messages, and clock tools are supplied by `pi-conversation`.
Their availability follows the model catalog and Codex Native's tool settings.

## Astra effort changes

Astra keeps the original reasoning effort in the request and receives native
`configuration_update` items when effort changes. The provider records those
boundaries in the Pi session, including after resume. Successful compaction
establishes a new effort baseline.

Enable **Auto reasoning** to expose `change_reasoning` to Astra in ordinary
reasoning mode. It can request low, medium, or high effort, with your starting
level as the floor. The extension restores the starting level when work ends;
a later manual change takes precedence. The tool is unavailable in Persistent
mode and on other models, including through Code Mode.

## Usage and Reserve

Press **Alt+U** in the managed harness to open the usage overlay with remaining
allowances, reset times, and available reset
credits. Refresh reads account state without spending a credit.
**Redeem one credit** requires confirmation for that redemption and uses a
durable request ID so an uncertain response can be retried safely.

Reserve handling follows backend authorization and account identity. It does
not silently turn a quota failure into a retry or redeem a credit. Requests
using the Reserve model retain their own identity instead of changing the
normal Luna model.

## Fast mode

Fast mode sends Codex priority routing (`service_tier: "priority"` plus the
`x-codex-routing-hint` header) on every request. It affects native models and
explicitly registered compatible routes. When enabled
the footer shows `fast`. Each session starts from the `fastModeDefault`
setting; a model role that already sets `serviceTier: "priority"` keeps fast
mode on even if you toggle it off.

## Context window

For GPT-5.6 and GPT-6 Astra models the package sets the model's context
window from a preset: `smart` (180k), `balanced` (272k), `enhanced` (400k),
`large` (600k), or `max` (1M). The footer shows the active preset. Another
extension may request a preset through the provider-owned
[context-window capability](context-window-protocol.md); without one, the
`contextWindowPreset` setting is used. Its published capability identity is
preserved for compatibility with older `pi-codex-native` SDK copies.

`contextAutoUpgrade` controls what happens when Pi reaches its compaction
threshold: `never` compacts, `mid-turn` moves to the next tier after a tool
turn that crosses the threshold and compacts once the run ends, and `always`
moves up a tier instead of compacting until `max` is reached.

## Keybindings

The package registers these actions:

| Action | Effect |
| --- | --- |
| `codex.usage.open` | Open allowances and reset credits. |
| `codex.fast.toggle` | Toggle fast mode for the current session. |
| `codex.context.cycle` | Move to the next context preset (wraps after `max`). |

Actions have no default keys. Bind them in `keybindings.json` in Pi's agent
directory (normally `~/.pi/agent/keybindings.json`). Each property name is an
action ID; each value is a key ID string or an array of key ID strings. For
example:

```json
{
  "codex.fast.toggle": "ctrl+shift+f",
  "codex.context.cycle": "ctrl+shift+w"
}
```

Keys take effect only when `pi-xsettings` is installed; the file is
read on load, so reload extensions after editing it.

## Settings

### Codex-compatible providers

Portable request features can be enabled for another OpenAI-compatible route
without changing Pi's provider or proxy. An integration registers the route
at extension load time:

```ts
import { registerCodexCompatibleProvider } from "@luan.sh/pi-codex-native";

const unregister = registerCodexCompatibleProvider({
  provider: "litellm",
  model: "gpt-5.6-luna",
  api: "openai-completions",
  features: { fastMode: true, textVerbosity: true, contextWindow: true },
  textVerbosityFormat: "chat-completions",
});
```

The returned disposer should be called when the integration itself is torn
down; a session shutdown (`/new`, `/resume`, or `/fork`) is not extension
teardown. The
registration only affects the listed model/API and does not enable native
Codex authentication, remote compaction, or `web__run`. Native
`openai-codex`/Responses behavior remains the default. Chat Completions
verbosity is sent as a top-level `verbosity` field; Responses uses
`text.verbosity`.

The registry covers ordinary Pi provider-request mutations and local model
metadata only. Native authentication, the Codex Responses transport, remote
compaction, prompt-envelope/response handling, diagnostics tied to native
transport, and `web__run` are intentionally not registered for compatible
providers because they use separate Codex services or wire protocols.

Settings use namespace `pi-codex-native` (label "Codex Native"), in the
`behavior` and `tools` categories. `reasoningMode` is stored in the current
session. Edit them with `/xsettings` when `pi-xsettings`
is installed; otherwise the defaults apply.

| Key | Default | Values |
| --- | --- | --- |
| `reasoningMode` | `pi` | `pi`, `persistent` |
| `currentTimeReminder` | `auto` | `auto`, `on`, `off` |
| `currentTimeReminderIntervalSeconds` | `"1"` | Whole seconds as a decimal string, from `0` through `18446744073709551615` |
| `currentTimeReminderDelivery` | `any_inference` | `any_inference`, `after_user_or_tool_output` |
| `currentTimeReminderSleep` | `auto` | `auto`, `on`, `off` |
| `sleepTool` | `true` | boolean |
| `sleepToolMode` | `model_driven` | `model_driven`, `always_on` |
| `sendMessageToUserAsync` | `false` | boolean |
| `cacheDiagnostics` | `off` | `off`, `status`, `status-and-log` |
| `lunaReserve` | `true` | boolean; backend-authorized fallback after a quota error |
| `autoReasoning` | `false` | boolean; Astra only |
| `portableCompaction` | `false` | boolean; readable summary alongside native compaction |
| `fallbackCompaction` | `true` | boolean |
| `fastModeDefault` | `false` | boolean |
| `contextWindowPreset` | `balanced` | `smart`, `balanced`, `enhanced`, `large`, `max` |
| `contextAutoUpgrade` | `never` | `never`, `mid-turn`, `always` |
| `textVerbosity` | `low` | `low`, `medium`, `high` |

- `cacheDiagnostics`: `status` shows prompt-cache hit/miss in the footer;
  `status-and-log` also writes metadata-only logs under
  `<Pi agent directory>/logs/codex-native/`.
- `fallbackCompaction`: for Codex models the package replaces Pi's compaction
  with Codex remote compaction and replays the checkpoint on later requests
  (custom `/compact` guidance is ignored with a warning). When remote
  compaction fails, `true` lets Pi compact locally, including the last remote
  checkpoint; `false` cancels compaction with an error notice.
- `portableCompaction`: generates a readable summary alongside a native
  encrypted checkpoint, allowing Pi to carry context when switching providers.
  It applies when native compaction owns the window; Context Windows supplies
  its own generated-summary option when installed.
- `textVerbosity`: sets `text.verbosity` on each provider request.

## `web__run`

`web__run` is a Codex-only tool. It accepts `search_query`, `image_query`,
`open`, `click`, `find`, `screenshot`, `finance`, `weather`, `sports`, and
`time` operations plus `response_length` and `settings.search_context_size`.
It rejects a non-Codex active model before starting the native process.

Requires a Rust toolchain (https://rustup.rs). The `web_run` binary builds
itself on first use under Pi's agent directory (`native/web-run/<version>/`).
Set `PI_CODEX_WEB_RUN_BIN` to use a prebuilt binary.

The binary reads the `openai-codex` credential from Pi's auth store
(`PI_AUTH_PATH` overrides the file). For a custom runner it also accepts
`PI_CODEX_ACCESS_TOKEN` and `PI_CODEX_ACCOUNT_ID`, which must be set together.
`PI_CODEX_SEARCH_URL` overrides the search endpoint; otherwise one is derived
from `PI_CODEX_BASE_URL` or the default Codex backend.

## Troubleshooting

- `No credentials` or an auth error: run
  `pi auth check --provider openai-codex`, then sign in again from a session
  using an `openai-codex/...` model.
- Browser login cannot return to Pi: make sure port `1455` is free. Set
  `PI_OAUTH_CALLBACK_HOST` if the callback must bind to a host other than
  `127.0.0.1`.
- `web_run` fails to build: make sure `cargo` is on `PATH`, or point
  `PI_CODEX_WEB_RUN_BIN` at a prebuilt binary.
- `web__run` rejects the model: the active model must use provider
  `openai-codex` and API `openai-codex-responses`.
- A custom search endpoint returns `403` or `404`: check the endpoint and
  credentials. The Codex backend can reject search for an account or proxy
  even when normal model requests work.

## Layout

| Responsibility | File |
| --- | --- |
| Pi registration and lifecycle | `src/extension.ts` |
| Provider, models, OAuth, transport | `src/provider/` |
| Responses stream and history conversion | `src/responses/` |
| Remote compaction and fallback | `src/compaction/` |
| Fast mode and context-window actions | `src/fast-mode.ts`, `src/context-window.ts` |
| Typed settings | `src/contributions/xsettings.ts` |
| Cache diagnostics status and logs | `src/diagnostics/` |
| Developer-message serialization | `src/prompt-payload-adapter.ts` |
| Code Mode bridge | `src/code-mode-tool-adapter.ts` |
| `web__run` schema, process, result, rendering | `src/tools/web-run/` |

## Develop

Source: https://github.com/luan/agents, directory
harnesses/pi/agent/packages/pi-codex-native. Run `bun run typecheck` and
`bun test test` in that directory.

## Recoverable context windows

When `pi-context-windows` is installed, the optional `pi-context/window/v1` capability
owns compaction and model-visible window projection. This provider resets its
transport continuation when the window changes and skips stale checkpoint
replay. It provides `pi-context/checkpoint/v1` for hybrid rollover: Context Windows
stores the generated encrypted checkpoint with its notes and readable summary;
this provider validates and replays only that window’s checkpoint. Endpoint
mismatches or checkpoint failures preserve the outgoing context and report an error. Normal tool requests are checked for the current window marker before
sending. Branch-summary requests keep their independent request context.
Without the capability, native remote compaction retains its existing behavior.

See [conversation and context recovery](../../../../../docs/pi-context-and-conversation.md).
