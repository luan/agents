import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { Glob } from "bun";

// The rule: a tool records state it needs at render, report or interrupt time in its own `execute`, never in a
// `tool_call`, `tool_execution_start` or `tool_execution_end` handler. A cell dispatches through
// `code-mode/nested-dispatch.ts` straight into `execute`, so pi fires none of those three, and 10 features built on
// them silently died. A new entry means a new handler: move its state into `execute`, or say why the event is right.
const ALLOWED_LIFECYCLE_HANDLERS: Record<string, string> = {
	"exec-command/index.ts": "Captures the UI context of the turn, which a cell's call does not change.",
	"shared/exploration-rendering.ts": "Paired with recordNestedExplorationStart/End, called from callNestedTool.",
	"prompt-storage/index.ts": "Restacks a widget; also listens to tool_execution_update, which a cell does fire.",
	"tool-policy/policy.ts": "Central policy and bound; nested-dispatch re-applies both for cells.",
	"tasks/index.ts": "Sets a per-turn flag; the cell's own `exec` end sets it just as well.",
	"tui/index.ts": "Refreshes the status line; `message_update` refreshes it during a cell.",
	"fileops/index.ts": "Marks the latest call for rendering; the edit tool's own execute marks it too (index.ts:4707).",
};

// `on.call(pi, "…")` is the second registration form. Matching only `.on("…")` hid fileops/index.ts:4675 from this test.
const LIFECYCLE_HANDLER_PATTERN =
	/(?:\.on\(\s*|\bon\.call\(\s*\w+\s*,\s*)"(tool_call|tool_execution_start|tool_execution_end)"/;

test("no extension records state in an event a cell's tool call never fires", async () => {
	const root = resolve(dirname(import.meta.path), "..");
	const found: string[] = [];
	for await (const path of new Glob("**/*.{ts,mjs}").scan({ cwd: root, absolute: true })) {
		if (path.endsWith(".test.ts")) continue;
		if (!LIFECYCLE_HANDLER_PATTERN.test(await readFile(path, "utf8"))) continue;
		found.push(relative(root, path));
	}

	expect(found.sort()).toEqual(Object.keys(ALLOWED_LIFECYCLE_HANDLERS).sort());
});
