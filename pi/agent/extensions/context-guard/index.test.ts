import "./setup-home";
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piExtension from "./index.js";
import { resetExecCommandContextGuardEnabled } from "./pi/index.js";
import { getStorePath } from "./pi/tool-paths.js";

type RegisteredTool = {
	name: string;
	parameters: Record<string, unknown>;
	renderCall?: (params: unknown, theme: any, context: any) => any;
	renderResult?: (result: any, state: any, theme: any, context: any) => any;
	execute: (
		_toolCallId: string,
		params: unknown,
		_signal?: AbortSignal,
		_onUpdate?: unknown,
		ctx?: { cwd?: string },
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

const originalCoreBin = process.env.CONTEXT_GUARD_BIN;
const originalProjectDir = process.env.CONTEXT_GUARD_PROJECT_DIR;
const originalPiConfigDir = process.env.PI_CONFIG_DIR;

afterEach(() => {
	if (originalCoreBin === undefined) delete process.env.CONTEXT_GUARD_BIN;
	else process.env.CONTEXT_GUARD_BIN = originalCoreBin;
	if (originalProjectDir === undefined) delete process.env.CONTEXT_GUARD_PROJECT_DIR;
	else process.env.CONTEXT_GUARD_PROJECT_DIR = originalProjectDir;
	if (originalPiConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalPiConfigDir;
	resetExecCommandContextGuardEnabled();
});

function createMockPi() {
	const tools: RegisteredTool[] = [];
	return {
		tools,
		on() {},
		registerCommand() {},
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
	};
}

function writeCore(logPath: string): void {
	const dir = mkdtempSync(join(tmpdir(), "context-guard-tools-test-"));
	const coreBin = join(dir, "context-guard-core.js");
	writeFileSync(
		coreBin,
		[
			`#!${process.execPath}`,
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.on('data', chunk => input += chunk);",
			"process.stdin.on('end', () => {",
			"  const request = JSON.parse(input);",
			`  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(request) + '\\n');`,
			"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify(request.params) }] }));",
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	chmodSync(coreBin, 0o755);
	process.env.CONTEXT_GUARD_BIN = coreBin;
}

describe("Context Guard v2 Pi tools", () => {
	it("registers only strict v2 tools", async () => {
		const pi = createMockPi();
		piExtension(pi);
		expect(pi.tools.map((tool) => tool.name)).toEqual(["cg_search", "cg_status", "cg_purge"]);
		for (const tool of pi.tools) {
			expect(tool.parameters.type ?? tool.parameters.anyOf).toBeDefined();
			expect(JSON.stringify(tool.parameters)).not.toContain('"additionalProperties":true');
		}
	});

	it("uses the v2 store for search, status, and purge", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-v2-store-"));
		const logPath = join(dir, "requests.log");
		const projectDir = join(dir, "tool-project");
		process.env.CONTEXT_GUARD_PROJECT_DIR = join(dir, "wrong-project");
		process.env.PI_CONFIG_DIR = join(dir, "config");
		writeCore(logPath);
		const pi = createMockPi();
		piExtension(pi);
		const search = pi.tools.find((tool) => tool.name === "cg_search")!;
		const status = pi.tools.find((tool) => tool.name === "cg_status")!;
		const purge = pi.tools.find((tool) => tool.name === "cg_purge")!;
		const ctx = { cwd: projectDir };
		await search.execute("search", { query: "needle", limit: 2 }, undefined, undefined, ctx);
		await status.execute("status", {}, undefined, undefined, ctx);
		await purge.execute(
			"purge",
			{ confirm: true, scope: "session", sessionId: "session-1" },
			undefined,
			undefined,
			ctx,
		);
		const requests = (await Bun.file(logPath).text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(requests.map((request) => request.command)).toEqual(["search", "status", "purge"]);
		expect(new Set(requests.map((request) => request.params.dbPath)).size).toBe(1);
		expect(requests[0].params.dbPath).toBe(getStorePath(projectDir));
		expect(requests[2].params).toMatchObject({ confirm: true, scope: "session", sessionId: "session-1" });
	});

	it("enforces exact purge schemas", async () => {
		const pi = createMockPi();
		piExtension(pi);
		const purge = pi.tools.find((tool) => tool.name === "cg_purge")!;
		await expect(purge.execute("bad-1", { confirm: false, scope: "project" })).rejects.toThrow();
		await expect(purge.execute("bad-2", { confirm: true, scope: "project", sessionId: "x" })).rejects.toThrow();
		await expect(purge.execute("bad-3", { confirm: true, scope: "session" })).rejects.toThrow();
	});
});
