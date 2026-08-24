# pi-developer-prompt

`pi-developer-prompt` builds the provider-ready prompt envelope for a Pi
turn. It keeps provider instructions, developer messages, and repository
instructions in their intended roles. It does not register tools or decide
how a provider serializes its request.

## Install

From the repository root:

```sh
just setup
pi install ./harnesses/pi/agent/packages/pi-developer-prompt
```

The package can load without a provider adapter, but it can only change a
provider request when that provider registers the public adapter capability.
`pi-codex-native` supplies the adapter for `openai-codex`.

## What Pi sends

For each agent start, the extension creates three separate parts:

1. **Provider instructions.** If Pi supplied a `SYSTEM.md`-backed custom
   prompt, that prompt is used with Pi's append-system text. If no custom
   prompt exists, the extension keeps Pi's already-built system prompt.
2. **Developer messages.** These are registered extension contributions,
   followed by the current environment as the final developer message. Tool
   usage guidance stays in each tool's description instead of becoming a
   separate prompt message.
3. **Contextual user instructions.** Pi's discovered repository context files,
   including `AGENTS.md` and `CLAUDE.md`, are combined into one hidden custom
   user message placed before conversation history. This is the only
   repository-instruction message; it is not mapped to a developer message.

The extension remembers the envelope for the session so compaction and
provider retries can rebuild it. Old prompt-audit copies are removed from
compaction and tree summaries.

## Add a developer contribution

Extensions register content through the package's public API:

```ts
registerDeveloperMessageContribution({
	id: "my-extension/mode",
	priority: 100,
	providers: ["openai-codex"],
	activeTools: ["read"],
	content: ({ sessionId, prompt }) =>
		prompt ? `<mode session="${sessionId}">...</mode>` : undefined,
});
```

`priority` sorts from low to high, with `id` breaking ties. `providers` and
`activeTools` gate a contribution. A function may return `undefined` for a
request that does not need the contribution. The current user prompt is
available in the render context.

Provider packages register an adapter through the versioned
`pi-developer-prompt/provider-payload-adapters/v1` capability. The adapter
reads and replaces the provider's system-prompt field and, when supported,
serializes native developer-role messages. The extension never maps a
developer message to a user message. The Codex adapter writes the final
instructions to `instructions` and tags managed developer items in the
Responses `input` array.

## Prompt audit settings

With `pi-xsettings`, the settings file is `~/.pi/agent/xsettings.toml`:

```toml
[appearance]
pi-developer-prompt.auditEntries = ["developer", "context-user"]
```

The default stores both composed developer messages and contextual user
messages as inspectable session entries. Set it to `[]`, `["developer"]`, or
`["context-user"]` when only one category is useful. Audit settings change
what is persisted for transcript inspection; they do not change the model
request.

Without `pi-xsettings`, the compiled default is used and no second settings
file is created.

## Troubleshooting

- A contribution is missing: check its `id`, provider name, active tool names,
  and whether its callback returns non-empty text. Contributions are filtered
  before ordering.
- A provider still receives the old prompt: that provider has not registered
  an adapter, or its adapter does not recognize the current payload. Check
  that the provider extension is loaded and uses the same provider id.
- `AGENTS.md` appears twice after compaction: inspect the custom message type
  `pi-developer-prompt/agents-md`. The extension removes both its current and
  legacy audit/context copies before rebuilding.
- Audit entries are not visible: enable `developer` or `context-user` in
  `pi-developer-prompt.auditEntries`, then expand the custom session entries.

## Architecture

| Concern | Owner |
| --- | --- |
| Pi hooks and session lifecycle | `src/extension.ts` |
| Prompt ordering and contribution registry | `src/developer-messages.ts` |
| Provider/system prompt selection | `src/provider-instructions.ts` |
| Provider payload capability | `src/provider-payload.ts` |
| Repository context-files message | `src/context-messages.ts` |
| Prompt envelope service | `src/prompt-envelope.ts` |
| Audit persistence and renderer | `src/audit-entries.ts` |
| Typed settings | `src/contributions/xsettings.ts` via `pi-xsettings/sdk` |

The package owns no provider transport, tool execution, model catalogue,
shortcuts, or provider-specific payload format.

## Validate

```sh
cd harnesses/pi/agent/packages/pi-developer-prompt
bun run typecheck
bun test test
```

From the repository root, `just check` runs the package with the other Pi
packages.
