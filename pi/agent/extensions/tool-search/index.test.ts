import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import toolSearchExtension from "./index.ts";

it("registers non-deferred project TOML tools when a session starts", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-eager-toml-"));
	const directory = join(cwd, ".pi", "codex-conversion-custom-tools");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "project_eager.toml"),
		'usage = "value to print"\ncommand = "printf"\ndefer_loading = false\n',
	);
	const tools: Array<{ name: string }> = [];
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const pi = {
		registerTool(tool: { name: string }) {
			tools.push(tool);
		},
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};

	toolSearchExtension(pi as never);
	for (const handler of handlers.get("session_start") ?? []) {
		handler({}, { cwd, sessionManager: { getSessionId: () => "toml-eager" } });
	}

	expect(tools.map((tool) => tool.name)).toContain("project_eager");
});
