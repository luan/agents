# pi-tool-search

`pi-tool-search` adds `tool_search`, a normal Pi tool that finds and activates
tools which are currently inactive. It searches only the scope assigned to it.
It does not inspect or modify the global tool hierarchy.

## Install

```sh
pi install ./harnesses/pi/agent/packages/pi-tool-search
```

There is no native binary. The package uses Pi's dynamic tool APIs and the
UI-free `pi-xsettings/sdk` and `pi-code-mode/sdk` contracts.

## Direct use and use under `exec`

`pi-code-mode` owns placement. `pi-tool-search` never decides whether
`tool_search` is direct or under `exec`.

- When `tool_search` is direct, its assigned scope is the other tools that
  were active in Pi at session start. Loading a match calls
  `pi.setActiveTools()` in that direct scope.
- When Code Mode puts `tool_search` under `exec`, its assigned scope is the
  sibling tools that Code Mode put under `exec`. Loading a match keeps the
  newly active tool under `exec`; it does not move the tool to Pi's direct
  list.

The Code Mode bridge is an execution adapter only. It gives Tool Search the
current sibling scope when Code Mode asks for it. Code Mode still owns the
direct-versus-`exec` decision and its settings. This is the only information
Tool Search receives about Code Mode.

## Deferred scope

All tools remain registered with Pi, but checked tools start inactive. At
session start, the package builds the xsettings picker from its assigned
scope. It does not use every tool returned by `pi.getAllTools()` as a global
search index.

The assigned scope is the boundary for both the picker and the search:

- A direct scope contains only the active direct tools that Tool Search was
  assigned.
- A nested scope contains only the other tools currently under `exec`.
- Registered tools outside that scope are invisible to `tool_search`.
- Disabled tools, tools omitted by a strict `--tools` selection, and tools
  outside the current scope are not deferred and do not appear in the picker.

Checked names are removed from that scope before the first model request.
`tool_search` itself stays active so the model can load a capability later.
When a query matches, activation is additive: existing active tools stay
active and only the matching tools are added. A no-match query changes
nothing. Loaded tools stay active for the rest of the session unless another
owner changes the scope.

## Configure

`pi-xsettings` stores the selection in `~/.pi/agent/xsettings.toml`:

```toml
[tools]
pi-tool-search.tools = ["exec_command", "web__run"]
```

`tools` is an unordered multi-select. Its options are rebuilt from the
assigned scope at session start and include each tool's name and description.
Reopen the session after changing the selection so the initial deferred set is
applied. The setting does not create or enable a tool that Pi did not already
make available.

## Use the tool

The input is an object with a required query and an optional result limit:

```json
{"query":"search the web","limit":3}
```

Search covers tool names, descriptions, parameter names, and parameter
descriptions. It returns at most eight ranked matches. A successful result
reports the ranked matches and the names it added; a no-match result reports
that no inactive tool matched. Tool Search activates matches on the next model
request, using Pi's normal dynamic-tool loading behavior.

If `tool_search` is under `exec`, call it as a nested method:

```js
const result = await tools.tool_search({ query: "search the web" });
text(result);
```

`tool_search` is not a parallel-call helper. There is no
`multi_tool_use.parallel` tool unless another package has separately
registered one. Use normal JavaScript such as `Promise.all` when calling
independent nested tools from `exec`.

## API contract

The package's Pi entry point is the default export from `src/index.ts`.
`createToolSearchResult` is also exported for consumers that need to build the
same model-visible result shape. `ToolSearchDetails` and
`ToolSearchRankedMatch` are the stable result types.

The result details are JSON-serializable and versioned:

```ts
type ToolSearchDetails = {
  version: 2;
  tool: "tool_search";
  status: "loaded" | "no_match";
  input: { query: string; normalizedQuery: string; limit: number };
  rankedMatches: Array<{ name: string; description: string; score: number }>;
  activation: { before: string[]; added: string[]; after: string[] };
  counts: { registered: number; searchable: number; matches: number; added: number };
  timing: { durationMs: number };
};
```

Extensions that provide their own searchable scope should pass a scope with
these operations:

```ts
type ToolSearchScope = {
  tools(): readonly { name: string; description: string; parameters?: unknown }[];
  active(): readonly string[];
  setActive(names: readonly string[]): void;
};
```

The scope owner remains responsible for deciding which names are available.
Tool Search only ranks inactive entries and asks that owner to add matches.

## Architecture map

| Role | Owner |
| --- | --- |
| Tool definition | `src/tools/tool-search/definition.ts` |
| Search and ranking | `src/search.ts` |
| Scope and deferred membership | `src/extension.ts` and the assigned scope owner |
| Execution bridge | `src/code-mode-adapter.ts` via `pi-code-mode/sdk` |
| Native boundary | None |
| Presentation owner | `src/tools/tool-search/presentation.ts` maps search semantics onto `pi-libtui` activities |
| Public capabilities | `tool_search`, `createToolSearchResult`, and result types |

## Troubleshooting

- **A tool is not in the picker:** it was inactive before Tool Search built its
  scope, disabled by Pi's tool selection, outside the current `exec` sibling
  set, or has not been registered yet. Tool Search does not make it deferred.
- **A checked tool still appears direct:** confirm `tool_search` is direct or
  under `exec` as intended, then restart the session. Placement belongs to
  `pi-code-mode`; Tool Search cannot change it.
- **A nested search cannot find a direct tool:** that is expected. A nested
  Tool Search can see only its sibling tools under `exec`.
- **A direct search cannot load a tool under `exec`:** that is also expected.
  Use a `tool_search` instance assigned to that nested scope.
- **A query returns no matches:** search is limited to inactive tools in the
  assigned scope. Check the exact name and description exposed by the picker.

## Validation

```sh
bun run --cwd=harnesses/pi/agent/packages/pi-tool-search typecheck
bun test --cwd=harnesses/pi/agent/packages/pi-tool-search
```

From the repository root, `just check` runs the aggregate TypeScript, Rust,
and harness checks.
