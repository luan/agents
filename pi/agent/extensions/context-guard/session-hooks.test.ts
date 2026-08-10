import "./setup-home";
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piExtension from "./index.js";
import { getCurrentContextGuardSessionId } from "./pi/current-session.js";
import { isExecCommandContextGuardEnabled, resetExecCommandContextGuardEnabled } from "./pi/index.js";

const originalCoreBin = process.env.CONTEXT_GUARD_BIN;
const originalProjectDir = process.env.CONTEXT_GUARD_PROJECT_DIR;

function createMockPi() {
	const hooks = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any }>();
	const tools: string[] = [];
	return {
		hooks,
		commands,
		tools,
		on(name: string, handler: (...args: any[]) => any) {
			hooks.set(name, handler);
		},
		registerCommand(name: string, def: { handler: (...args: any[]) => any }) {
			commands.set(name, def);
		},
		registerTool(def: { name: string }) {
			tools.push(def.name);
		},
	};
}

afterEach(() => {
	if (originalCoreBin === undefined) delete process.env.CONTEXT_GUARD_BIN;
	else process.env.CONTEXT_GUARD_BIN = originalCoreBin;
	if (originalProjectDir === undefined) delete process.env.CONTEXT_GUARD_PROJECT_DIR;
	else process.env.CONTEXT_GUARD_PROJECT_DIR = originalProjectDir;
	resetExecCommandContextGuardEnabled();
});

describe("Context Guard focused extension lifecycle", () => {
	it("tracks session identity and registers only capture retrieval surfaces", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-lifecycle-"));
		const coreBin = join(dir, "context-guard-core.js");
		process.env.CONTEXT_GUARD_BIN = coreBin;
		process.env.CONTEXT_GUARD_PROJECT_DIR = join(dir, "project");
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"let input = '';",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  const payload = request.command === 'status' ? { captures: 2 } : {};",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify(payload) }] }));",
				"});",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);

		const pi = createMockPi();
		piExtension(pi);
		expect(isExecCommandContextGuardEnabled()).toBe(true);
		expect(pi.tools.sort()).toEqual(["cg_purge", "cg_search", "cg_status"]);
		expect([...pi.hooks.keys()].sort()).toEqual(["session_shutdown", "session_start"]);
		expect([...pi.commands.keys()]).toEqual(["cg-status"]);

		const sessionFile = join(dir, "session.json");
		pi.hooks.get("session_start")?.({}, { sessionManager: { getSessionFile: () => sessionFile } });
		expect(getCurrentContextGuardSessionId()).toMatch(/^[a-f0-9]{16}$/);
		const status = await pi.commands.get("cg-status")?.handler({});
		expect(status).toEqual({ text: JSON.stringify({ captures: 2 }) });

		pi.hooks.get("session_shutdown")?.();
		expect(getCurrentContextGuardSessionId()).toBeUndefined();
	});
});
