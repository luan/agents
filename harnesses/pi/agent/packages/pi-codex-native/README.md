# pi-codex-native

`pi-codex-native` adds the `openai-codex` provider to Pi. It talks to the
ChatGPT-backed Codex Responses endpoint, keeps the provider's native request
and response format, and registers the `web__run` tool.

It is an OpenAI Codex subscription provider. It is not a general OpenAI API
adapter, and it does not add shell, file, Code Mode, MCP, or image-generation
tools.

## Install

From the repository root:

```sh
just setup
pi install ./harnesses/pi/agent/packages/pi-codex-native
```

`just setup` installs the workspace dependencies and builds the Rust
`web_run` binary. `pi install` adds this package to the Pi settings file used
by the current command.

## Sign in and use

Start Pi and choose an `openai-codex/...` model. Pi asks this provider to log
in the first time. The provider offers:

- Browser login, using a local OAuth callback on port `1455`.
- Device-code login for a headless machine.

Pi stores the OAuth credential in its normal auth store and refreshes it when
needed. Check the provider without starting a session with:

```sh
pi auth check --provider openai-codex
```

The package currently provides these models:

| Model | Input | Notes |
| --- | --- | --- |
| `gpt-5.3-codex-spark` | Text | 128k context; no tool-search flag. |
| `gpt-5.4` | Text, images | Tool search. |
| `gpt-5.4-mini` | Text, images | Tool search. |
| `gpt-5.5` | Text, images | Tool search. |
| `gpt-5.6-luna` | Text, images | Additional tools and tool search. |
| `gpt-5.6-sol` | Text, images | Additional tools and tool search. |
| `gpt-5.6-terra` | Text, images | Additional tools and tool search. |

Use a model explicitly when needed:

```sh
pi --model openai-codex/gpt-5.6-luna
```

## Settings

Settings are registered with `pi-xsettings` and are stored in
`~/.pi/agent/xsettings.toml`. The package uses its compiled defaults when the
xsettings host is not installed; it does not create a second settings file.

The settings namespace is `pi-codex-native` under the `[behavior]` category:

```toml
[behavior]
pi-codex-native.cacheDiagnostics = "off"
pi-codex-native.fallbackCompaction = true
pi-codex-native.fastModeDefault = false
pi-codex-native.contextWindowPreset = "balanced"
pi-codex-native.contextAutoUpgrade = "never"
pi-codex-native.textVerbosity = "low"
```

- `cacheDiagnostics`: `off`, `status`, or `status-and-log`. The last option
  writes metadata-only logs under `~/.pi/agent/logs/codex-native/`.
- `fallbackCompaction`: let Pi compact locally when native remote compaction
  fails. The default is `true`.
- `fastModeDefault`: start each new or resumed session with Codex priority
  routing. Fast mode only affects eligible Codex models. The package registers
  `codex.fast.toggle`; it does not choose a default shortcut.
- `contextWindowPreset`: `smart` (180k), `balanced` (272k), `enhanced`
  (400k), `large` (600k), or `max` (1M). This setting applies to GPT-5.6
  Codex models. The package also registers `codex.context.cycle`.
- `contextAutoUpgrade`: `never`, `mid-turn`, or `always`. These settings
  control whether GPT-5.6 can move to a larger context tier before compacting.
- `textVerbosity`: `low`, `medium`, or `high` for the next provider request.

Other extensions may request a context preset through the versioned
`pi-libcontext` capability. A role selection is optional; without one, the
Codex setting above is used.

## `web__run`

`web__run` is a Codex-only tool. It supports web search and source inspection,
image search, finance, weather, sports, and time operations. It rejects other
providers before starting the Rust process. When Code Mode is installed, the
same operation is exposed through Code Mode's adapter; this package still
owns the definition and execution.

The extension finds `web_run` in `target/release` or `target/debug`. If you
need a different executable, set:

```sh
export PI_CODEX_WEB_RUN_BIN=/absolute/path/to/web_run
```

The binary normally reads the OpenAI Codex credential from Pi's auth store.
For a custom runner setup, it also accepts `PI_CODEX_ACCESS_TOKEN` and
`PI_CODEX_ACCOUNT_ID` together. `PI_CODEX_SEARCH_URL` overrides the search
endpoint; `PI_CODEX_BASE_URL` derives one when the explicit URL is absent.

## Troubleshooting

- `No credentials` or an auth error: run
  `pi auth check --provider openai-codex`, then sign in again from a session
  using an `openai-codex/...` model.
- Browser login cannot return to Pi: make sure port `1455` is available. Set
  `PI_OAUTH_CALLBACK_HOST` if the callback must bind to another local host.
- `web_run binary is not built`: run `cargo build -p web-run` or `just setup`.
- `web__run` rejects the model: the active model must use provider
  `openai-codex` and API `openai-codex-responses`.
- A custom search endpoint returns `403` or `404`: check the endpoint and
  credentials. The Codex backend can reject search for an account or proxy
  even when normal model requests work.

## Architecture

| Concern | Owner |
| --- | --- |
| Pi registration and lifecycle | `src/extension.ts` |
| Provider registration, models, OAuth, transport | `src/provider/` |
| Remote-v2 and fallback compaction | `src/compaction/` |
| Fast mode and context-window actions | `src/fast-mode.ts`, `src/context-window.ts` |
| Typed settings | `src/contributions/xsettings.ts` via `pi-xsettings/sdk` |
| Codex developer-message serialization | `src/prompt-payload-adapter.ts` |
| Code Mode bridge | `src/code-mode-tool-adapter.ts` via `pi-code-mode/sdk` |
| `web__run` schema, process, and result details | `src/tools/web-run/` |
| Tool presentation | `src/tools/web-run/presentation.ts` maps web semantics onto `pi-libtui` activities |

## Validate

```sh
cd harnesses/pi/agent/packages/pi-codex-native
bun run typecheck
bun test test
```

From the repository root, `just check` runs the package with the other Pi
packages and the Rust workspace.
