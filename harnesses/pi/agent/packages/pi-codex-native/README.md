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

The package registers two actions:

| Action | Effect |
| --- | --- |
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

Settings use namespace `pi-codex-native` (label "Codex Native"), all in the
`behavior` category. Edit them with `/xsettings` when `pi-xsettings`
is installed; otherwise the defaults apply.

| Key | Default | Values |
| --- | --- | --- |
| `cacheDiagnostics` | `off` | `off`, `status`, `status-and-log` |
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
