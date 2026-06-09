import "./setup-home";
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fileopsExtension from "../fileops/index.ts";
import piExtension, { _toolRuntimeReady } from "./index.js";
import { resetExecCommandContextGuardEnabled } from "./pi/index.js";

type RegisteredTool = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	renderShell?: "self";
	renderCall?: (
		args: unknown,
		theme: typeof testTheme,
		context: Record<string, unknown>,
	) => { render(width: number): string[] };
	renderResult?: (
		result: { content: Array<{ type: string; text: string }> },
		state: { expanded: boolean; isPartial: boolean },
		theme: typeof testTheme,
		context: Record<string, unknown>,
	) => { render(width: number): string[] };
	execute: (
		_toolCallId: string,
		params: unknown,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
	}>;
};

const testTheme = {
	fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
};

const originalCoreBin = process.env.CONTEXT_GUARD_BIN;
const originalSkipLocalBin = process.env.CONTEXT_GUARD_SKIP_LOCAL_BIN;
const originalPath = process.env.PATH;
const originalPiConfigDir = process.env.PI_CONFIG_DIR;
const originalProjectDir = process.env.CONTEXT_GUARD_PROJECT_DIR;
const originalFileopsVariant = process.env.PI_FILEOPS_EDIT_VARIANT;

afterEach(() => {
	if (originalCoreBin === undefined) {
		delete process.env.CONTEXT_GUARD_BIN;
	} else {
		process.env.CONTEXT_GUARD_BIN = originalCoreBin;
	}
	if (originalSkipLocalBin === undefined) {
		delete process.env.CONTEXT_GUARD_SKIP_LOCAL_BIN;
	} else {
		process.env.CONTEXT_GUARD_SKIP_LOCAL_BIN = originalSkipLocalBin;
	}
	if (originalPiConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = originalPiConfigDir;
	}
	if (originalProjectDir === undefined) {
		delete process.env.CONTEXT_GUARD_PROJECT_DIR;
	} else {
		process.env.CONTEXT_GUARD_PROJECT_DIR = originalProjectDir;
	}
	if (originalFileopsVariant === undefined) {
		delete process.env.PI_FILEOPS_EDIT_VARIANT;
	} else {
		process.env.PI_FILEOPS_EDIT_VARIANT = originalFileopsVariant;
	}
	process.env.PATH = originalPath;
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

describe("piExtension — direct cg_* tool registration", () => {
	it("registers the context-guard tools directly", async () => {
		const pi = createMockPi();

		piExtension(pi);
		await _toolRuntimeReady;

		expect(pi.tools.map((tool) => tool.name)).toEqual([
			"cg_process_file",
			"cg_index",
			"cg_search",
			"cg_fetch",
			"cg_status",
			"cg_check",
			"cg_purge",
		]);
	});

	it("renders direct context tools with exec-command styling", async () => {
		const pi = createMockPi();

		piExtension(pi);
		await _toolRuntimeReady;

		const search = pi.tools.find((tool) => tool.name === "cg_search");
		expect(search?.renderCall).toBeDefined();
		expect(search?.renderResult).toBeDefined();

		const callText = search!.renderCall!({ queries: ["render marker"] }, testTheme, { isPartial: false })
			.render(120)
			.join("\n");
		expect(search?.renderShell).toBe("self");
		expect(callText).toContain("<bold>Context searched");
		expect(callText).toContain("via context-guard");
		expect(callText).not.toContain("Context: search");
		expect(callText).not.toContain("<bold>Ran</bold>");

		const resultText = search!.renderResult!(
			{ content: [{ type: "text", text: "## render marker\nresult body" }] },
			{ expanded: false, isPartial: false },
			testTheme,
			{ args: { queries: ["render marker"] } },
		)
			.render(120)
			.join("\n");
		expect(resultText).toContain("result body");
		expect(resultText).toContain("<toolTitle><bold>render marker</bold></toolTitle>");
		expect(resultText).not.toContain("  └ ");
		expect(resultText).not.toContain("Context: search");
	});

	it("reports an explicit install error when cg_check cannot find the Rust core", async () => {
		delete process.env.CONTEXT_GUARD_BIN;
		process.env.CONTEXT_GUARD_SKIP_LOCAL_BIN = "1";
		process.env.PATH = "";

		const pi = createMockPi();
		piExtension(pi);

		const check = pi.tools.find((tool) => tool.name === "cg_check");
		expect(check).toBeDefined();

		await expect(check!.execute("call-1", {})).rejects.toThrow("Context Guard core binary not found");
		await expect(check!.execute("call-2", {})).rejects.toThrow("cargo build -p context-guard");
	});

	it("delegates cg_check to the configured Context Guard core binary", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-core-test-"));
		const coreBin = join(dir, "context-guard-core.js");
		writeFileSync(
			coreBin,
			[
				"#!/usr/bin/env node",
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  if (request.command !== 'check') process.exit(2);",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: 'context-guard check from rust core' }] }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);
		process.env.CONTEXT_GUARD_BIN = coreBin;

		const pi = createMockPi();
		piExtension(pi);

		const check = pi.tools.find((tool) => tool.name === "cg_check");
		const result = await check!.execute("call-1", {});
		const text = result.content.map((item) => item.text).join("\n");

		expect(text).toBe("context-guard check from rust core");
	});

	it("discovers the Context Guard core binary on PATH", async () => {
		delete process.env.CONTEXT_GUARD_BIN;
		process.env.CONTEXT_GUARD_SKIP_LOCAL_BIN = "1";
		const dir = mkdtempSync(join(tmpdir(), "context-guard-core-path-test-"));
		const coreBin = join(dir, "context-guard");
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  if (request.command !== 'check') process.exit(2);",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: 'context-guard check from PATH core' }] }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);
		process.env.PATH = dir;

		const pi = createMockPi();
		piExtension(pi);

		const check = pi.tools.find((tool) => tool.name === "cg_check");
		const result = await check!.execute("call-1", {});
		const text = result.content.map((item) => item.text).join("\n");

		expect(text).toBe("context-guard check from PATH core");
	});

	it("delegates cg_process_file to the configured Context Guard core binary", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-process-file-core-test-"));
		const coreBin = join(dir, "context-guard-core.js");
		const filePath = join(dir, "input.txt");
		writeFileSync(filePath, "abc", "utf8");
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  if (request.command !== 'process_file') process.exit(2);",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: 'processed by rust core: ' + request.params.path }] }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);
		process.env.CONTEXT_GUARD_BIN = coreBin;

		const pi = createMockPi();
		piExtension(pi);

		const processFile = pi.tools.find((tool) => tool.name === "cg_process_file");
		const result = await processFile!.execute("call-1", {
			path: filePath,
			language: "shell",
			code: "wc -c",
		});
		const text = result.content.map((item) => item.text).join("\n");
		expect(text).toContain(`processed by rust core: ${filePath}`);
		expect(text).toContain("Hashline edit anchor:");
		const anchor = text.match(/\[.*input\.txt#[0-9A-F]{4}\]/)?.[0];
		expect(anchor).toBeDefined();

		process.env.PI_FILEOPS_EDIT_VARIANT = "hashline";
		const fileops = createMockPi();
		fileopsExtension(fileops as any);
		const edit = fileops.tools.find((tool) => tool.name === "edit");
		await (edit!.execute as any)("edit-1", { input: `${anchor}\nreplace 1..1:\n+xyz\n` }, undefined, undefined, {
			cwd: dir,
		});
		expect(readFileSync(filePath, "utf8")).toBe("xyz");
	});

	it("delegates cg_index, cg_search, and cg_purge to the configured Context Guard core binary", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-store-core-test-"));
		const coreBin = join(dir, "context-guard-core.js");
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: request.command + ' via rust core' }] }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);
		process.env.CONTEXT_GUARD_BIN = coreBin;

		const pi = createMockPi();
		piExtension(pi);

		const index = pi.tools.find((tool) => tool.name === "cg_index");
		const search = pi.tools.find((tool) => tool.name === "cg_search");
		const purge = pi.tools.find((tool) => tool.name === "cg_purge");

		const filePath = join(dir, "input.txt");
		writeFileSync(filePath, "abc\n", "utf8");
		await expect(index!.execute("call-1", { content: "hello", source: "adapter" })).resolves.toEqual({
			content: [{ type: "text", text: "index via rust core" }],
			details: {},
		});
		const pathIndexResult = await index!.execute("call-1b", { path: filePath });
		const pathIndexText = pathIndexResult.content.map((item) => item.text).join("\n");
		expect(pathIndexText).toContain("index via rust core");
		expect(pathIndexText).toContain("Hashline edit anchor:");
		expect(pathIndexText).toMatch(/\[.*input\.txt#[0-9A-F]{4}\]/);
		await expect(search!.execute("call-2", { queries: ["hello"] })).resolves.toEqual({
			content: [{ type: "text", text: "search via rust core" }],
			details: {},
		});
		await expect(purge!.execute("call-3", { confirm: true, scope: "project" })).resolves.toEqual({
			content: [{ type: "text", text: "purge via rust core" }],
			details: {},
		});
	});

	it("delegates cg_index, cg_search, cg_fetch, and cg_purge even when params rely on Rust-side validation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-rust-validation-test-"));
		const coreBin = join(dir, "context-guard-core.js");
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify({ command: request.command, params: request.params }) }] }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);
		process.env.CONTEXT_GUARD_BIN = coreBin;

		const pi = createMockPi();
		piExtension(pi);

		const index = pi.tools.find((tool) => tool.name === "cg_index");
		const search = pi.tools.find((tool) => tool.name === "cg_search");
		const fetch = pi.tools.find((tool) => tool.name === "cg_fetch");
		const purge = pi.tools.find((tool) => tool.name === "cg_purge");

		const indexPayload = JSON.parse((await index!.execute("call-1", {})).content[0]?.text ?? "{}");
		const searchPayload = JSON.parse((await search!.execute("call-2", {})).content[0]?.text ?? "{}");
		const fetchPayload = JSON.parse((await fetch!.execute("call-3", {})).content[0]?.text ?? "{}");
		const purgePayload = JSON.parse(
			(
				await purge!.execute("call-4", {
					confirm: true,
					sessionId: "session-123",
					scope: "project",
				})
			).content[0]?.text ?? "{}",
		);

		expect(indexPayload.command).toBe("index");
		expect(searchPayload.command).toBe("search");
		expect(fetchPayload.command).toBe("fetch");
		expect(purgePayload.command).toBe("purge");
		expect(purgePayload.params.sessionId).toBe("session-123");
		expect(purgePayload.params.scope).toBe("project");
	});

	it("delegates repeated cg_search calls to the core with project/session/config paths", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-search-delegate-test-"));
		const coreBin = join(dir, "context-guard-core.js");
		const logPath = join(dir, "requests.log");
		const projectDir = join(dir, "project");
		const configDir = join(dir, "config");
		process.env.CONTEXT_GUARD_BIN = coreBin;
		process.env.CONTEXT_GUARD_PROJECT_DIR = projectDir;
		process.env.PI_CONFIG_DIR = configDir;

		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"const fs = require('node:fs');",
				`const logPath = ${JSON.stringify(logPath)};`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  fs.appendFileSync(logPath, JSON.stringify(request) + '\\n', 'utf8');",
				"  const searchCount = fs.readFileSync(logPath, 'utf8').split('\\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.command === 'search').length;",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: 'search call #' + searchCount }] }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);

		const pi = createMockPi();
		piExtension(pi);

		const search = pi.tools.find((tool) => tool.name === "cg_search");
		expect(search).toBeDefined();

		for (let i = 1; i <= 9; i++) {
			await expect(search!.execute(`call-${i}`, { queries: ["hello"], limit: 5 })).resolves.toEqual({
				content: [{ type: "text", text: `search call #${i}` }],
				details: {},
			});
		}

		const requests = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)) as Array<{ command: string; params: Record<string, string> }>;
		const searchRequests = requests.filter((request) => request.command === "search");
		expect(searchRequests).toHaveLength(9);
		expect(searchRequests[0]?.params.projectDir).toBe(projectDir);
		expect(searchRequests[0]?.params.configDir).toBe(configDir);
		expect(searchRequests[0]?.params.sessionDbPath).toContain("context-guard/sessions");
	});

	it("delegates cg_fetch to the configured Context Guard core binary", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-batch-fetch-core-test-"));
		const coreBin = join(dir, "context-guard-core.js");
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: request.command + ' via rust core' }] }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);
		process.env.CONTEXT_GUARD_BIN = coreBin;

		const pi = createMockPi();
		piExtension(pi);

		const fetch = pi.tools.find((tool) => tool.name === "cg_fetch");

		await expect(fetch!.execute("call-2", { url: "http://127.0.0.1:1", source: "fake" })).resolves.toEqual({
			content: [{ type: "text", text: "fetch via rust core" }],
			details: {},
		});
	});

	it("passes cg_fetch sessionDbPath and concurrency through to the Rust core", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-fetch-params-test-"));
		const coreBin = join(dir, "context-guard-core.js");
		process.env.CONTEXT_GUARD_BIN = coreBin;
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  const params = request.params || {};",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify({ concurrency: params.concurrency, sessionDbPath: params.sessionDbPath, requestCount: params.requests?.length }) }] }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);

		const pi = createMockPi();
		piExtension(pi);

		const fetch = pi.tools.find((tool) => tool.name === "cg_fetch");
		expect(fetch).toBeDefined();

		const result = await fetch!.execute("call-1", {
			requests: [
				{ url: "http://127.0.0.1:1", source: "one" },
				{ url: "http://127.0.0.1:2", source: "two" },
			],
			concurrency: 4,
		});
		const payload = JSON.parse(result.content[0]?.text ?? "{}");

		expect(payload.concurrency).toBe(4);
		expect(payload.requestCount).toBe(2);
		expect(String(payload.sessionDbPath)).toContain("context-guard/sessions");
	});

	it("delegates cg_status to the configured Context Guard core binary", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-status-core-test-"));
		const coreBin = join(dir, "context-guard-core.js");
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  if (request.command !== 'status') process.exit(2);",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: 'status via rust core' }] }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);
		process.env.CONTEXT_GUARD_BIN = coreBin;

		const pi = createMockPi();
		piExtension(pi);

		const status = pi.tools.find((tool) => tool.name === "cg_status");
		await expect(status!.execute("call-1", {})).resolves.toEqual({
			content: [{ type: "text", text: "status via rust core" }],
			details: {},
		});
	});

	it("delegates cg_status with session and config paths", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-status-paths-test-"));
		const coreBin = join(dir, "context-guard-core.js");
		const projectDir = join(dir, "project");
		const configDir = join(dir, "config");
		process.env.CONTEXT_GUARD_BIN = coreBin;
		process.env.CONTEXT_GUARD_PROJECT_DIR = projectDir;
		process.env.PI_CONFIG_DIR = configDir;
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  const params = request.params || {};",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify({ sessionDbPath: params.sessionDbPath, sessionsDir: params.sessionsDir, configDir: params.configDir, projectDir: params.cwd }) }] }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);

		const pi = createMockPi();
		piExtension(pi);

		const status = pi.tools.find((tool) => tool.name === "cg_status");
		const result = await status!.execute("call-1", {});
		const payload = JSON.parse(result.content[0]?.text ?? "{}");

		expect(payload.projectDir).toBe(projectDir);
		expect(payload.configDir).toBe(configDir);
		expect(payload.sessionsDir).toContain("context-guard/sessions");
		expect(payload.sessionDbPath).toContain("context-guard/sessions");
	});

	it("delegates session-scoped cg_purge with the session DB path", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-purge-paths-test-"));
		const coreBin = join(dir, "context-guard-core.js");
		process.env.CONTEXT_GUARD_BIN = coreBin;
		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify({ sessionDbPath: request.params.sessionDbPath, sessionId: request.params.sessionId, scope: request.params.scope }) }] }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);

		const pi = createMockPi();
		piExtension(pi);

		const purge = pi.tools.find((tool) => tool.name === "cg_purge");
		const result = await purge!.execute("call-1", {
			confirm: true,
			scope: "session",
			sessionId: "session-123",
		});
		const payload = JSON.parse(result.content[0]?.text ?? "{}");

		expect(payload.scope).toBe("session");
		expect(payload.sessionId).toBe("session-123");
		expect(payload.sessionDbPath).toContain("context-guard/sessions");
	});
});
