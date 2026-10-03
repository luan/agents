# pi-token-burden

Standalone token/context report for Pi. `/token-burden` opens a snapshot in TUI
mode; it never changes settings, skills, prompts, or session history, and never
makes a model request. On the Tools tab, Space safely enables/disables the
selected tool for future turns through Pi's public API; this is not persisted and
does not rewrite historical usage. Reopen it to refresh the snapshot.

## Report

- **Overview:** current context utilization, prompt breakdown, tool schema costs,
  context-file inputs, and skills. Recorded usage opens with `u`; command inventory
  and measurement limitations are available in `?` help.
- **Prompt:** section-by-section drilldown (including nested and repeated Markdown
  headings) and loaded context-file base inputs. Fenced code is not split into
  headings. Context files overlap the prompt, so their estimates are not additive.
- **Tools:** every registered tool, active/inactive state, definition and parameter
  schema estimates, observed branch calls, provenance, guidelines, and hypothetical
  uncached input cost at the selected model's current rate. Definitions are sorted
  by estimated size. Full descriptions and schemas are available in drilldown.
- **Usage:** recorded input, output, cache read/write, total tokens and costs for
  the current branch and the entire session tree. Branch work records include
  assistant calls, reported nested tool usage, compaction, and branch summaries.
- **Skills:** loaded metadata, file paths, advertisement estimates, and whether
  model invocation is enabled. Skill bodies are not read or executed; there are
  deliberately no enable/disable actions.

The presentation follows the historical `164add8873` report: a centered,
80-column overlay with one frame, a context headline and bar, a colored stacked
system-prompt breakdown, and a compact table with at most eight visible rows.
There are no fullscreen tabs, nested cards, or persistent inspector. Narrow and
short terminals keep the numbers and table visible with less decoration.

Use up/down or j/k to select, Enter/l to drill into prompt sections, tools, or
skills, and Escape/h/q to return to the overview. Escape/q closes the overview.
`u` opens recorded usage; `/` filters the current table. Left/right also switches
report views. Pi's injected selection bindings control rows, pages, confirmation,
and cancellation. Enter or `e` on a leaf opens scrollable details; closing those
details preserves the selected row. Home/End jump within lists and detail text.
Shared controls own pointer row activation, search-field focus, and dialog buttons.

Token estimates and percentages are right-aligned so long resource names cannot
hide the numbers. Context-file estimates overlap the prompt, tool definitions are
separate, and skill wrapper estimates are not summed. On Tools, Space toggles the
selected tool after Pi is idle; its status line and rows update without changing
the selection. No tool state changes merely by selecting or viewing a row.

## Measurement limits

- `ceil(text.length / 4)` is a character heuristic, **not a tokenizer**. Rounding
  each section may differ from estimating the full prompt. Definition estimates
  include compact JSON for name, description, and parameters; provider-specific
  wrappers and deferred-tool serialization are not available here.
- Context utilization comes from `ctx.getContextUsage()` (Pi's current estimate),
  not cumulative usage. After compaction it can be unavailable. An unavailable
  reading is never displayed as zero and has no fabricated progress bar.
- Usage and dollar costs are the values stored by Pi, not independently verified
  billing. Missing summary usage is counted explicitly; totals cover recorded
  work only. Optional nested LLM work that a tool did not report is unknowable.
  Stored zero usage remains a recorded zero, including provider error placeholders.
  Session totals include all branches in this session, not other session files.
- Active/inactive is the only supported tool reach distinction. Public APIs do
  not prove nested, deferred, blocked, or unreachable states. Observed tool-call
  blocks are not proof that execution succeeded or even started.
- Tool input costs are hypothetical per-inclusion estimates at the **current**
  model rate, regardless of active state; they are not attributed historical
  costs. Zero model pricing is preserved, not treated as verified free service.
- Tool guidelines can already occur in the system prompt. Skill estimates use
  Pi's single-skill advertisement formatter (including its wrapper), not the skill
  body, and therefore cannot be added to obtain the whole skill advertisement.
- Prompt sections are Pi's current system-prompt string, not the final provider
  payload. Context files and skills are the current **base** prompt inputs.
  Per-turn extension changes, later context mutations, and provider rewrites may
  differ. Arbitrary prompt text cannot be attributed to extension owners; only
  public source metadata is used. No private registries or old policy assumptions
  are consulted.
- Prompt and schema detail may contain sensitive text already available to the
  current session. It stays local in the report; no files or logs are written.
  Terminal controls in resource text are stripped before display.

## Architecture map

| Responsibility | Owner |
| --- | --- |
| Tool definition | None; this extension adds no model-facing tool |
| Command/composition | `src/extension.ts` registers `/token-burden`, guards TUI mode, and opens `ctx.ui.custom` |
| Execution/collection | `src/runtime/collect-report.ts` reads `pi.getAllTools`, `getActiveTools`, `getCommands`, command-context prompt options, context utilization, and read-only session entries |
| State | One immutable report snapshot per invocation; `ReportScreen` owns local tab, selection, and detail viewport state |
| Pure domain | `src/core/` owns report types, prompt partitioning, character estimates, and usage aggregation |
| Presentation | `src/ui/report-rows.ts` builds domain rows; `burden-bar.ts` paints the historical headline and stacked bar; `report-screen.ts` composes pi-libtui `DialogOverlay`, `ComponentStack`, `SelectableList`, and `SemanticInput`; details use the shared `ScrollView` and dialog controls |
| Native boundary | None in this package; the bundled pi-libtui extension owns generic host compatibility |
| Public capabilities | No structural capability or registry; `src/index.ts` exports the collector, estimate helper, and report types |

No settings, custom actions, persistence, provider dependencies, or extension
cross-imports are required. The package bundles its pi-libtui runtime dependency
and loads that dependency's host extension independently.

This restores the useful report views from the historical token-burden snapshot
`164add8873` (removed in `e762009e`), without restoring obsolete tool-policy imports,
extension re-execution for attribution, or skill-configuration writes.

## Validation

From this directory: `bun run typecheck` and `bun test test`.
From repository root: `bun run lint:pi`,
`just pi-install-check harnesses/pi/agent/packages/pi-token-burden`, and `just check`.
Use a temporary agent directory for live and install checks, never the live
`~/.pi/agent/settings.json` symlink.
