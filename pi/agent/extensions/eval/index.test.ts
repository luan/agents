import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import evalExtension, { type EvalLanguage, EvalRuntime, EvalSessionRegistry } from "./index.js";

let runtime: EvalRuntime | undefined;
const originalCoreBin = process.env.CONTEXT_GUARD_BIN;
const originalProjectDir = process.env.CONTEXT_GUARD_PROJECT_DIR;

afterEach(() => {
	runtime?.reset();
	runtime = undefined;
	if (originalCoreBin === undefined) delete process.env.CONTEXT_GUARD_BIN;
	else process.env.CONTEXT_GUARD_BIN = originalCoreBin;
	if (originalProjectDir === undefined) delete process.env.CONTEXT_GUARD_PROJECT_DIR;
	else process.env.CONTEXT_GUARD_PROJECT_DIR = originalProjectDir;
});

function execute(code: string, language: EvalLanguage, cwd = process.cwd(), timeoutSeconds = 10) {
	runtime ??= new EvalRuntime();
	return runtime.execute(code, { language, cwd, timeoutSeconds });
}

test("JavaScript and TypeScript share retained state", async () => {
	const first = await execute("const answer: number = 41; display(answer);", "ts");
	const second = await execute("display(answer + 1);", "js");

	expect(first.output).toBe("41");
	expect(second.output).toBe("42");
});

test("Python retains state and supports read, display, final expressions, and top-level await", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-eval-python-"));
	writeFileSync(join(cwd, "data.json"), JSON.stringify({ value: 7 }), "utf8");

	const first = await execute(
		"import asyncio, json\nvalue = json.loads(read('data.json'))['value']\nvalue = await asyncio.sleep(0, result=value)\nvalue",
		"py",
		cwd,
	);
	const second = await execute("display(value * 2)", "py", cwd);

	expect(first.output).toBe("7");
	expect(second.output).toBe("14");
});

test("reset clears only the selected language kernel", async () => {
	await execute("const jsValue = 3;", "js");
	await execute("py_value = 4", "py");
	runtime?.reset("py");

	expect((await execute("display(jsValue)", "js")).output).toBe("3");
	expect((await execute("display('py_value' in globals())", "py")).output).toBe("false");
});

test("session registry isolates retained state", async () => {
	const registry = new EvalSessionRegistry();
	try {
		await registry
			.runtime("one")
			.execute("const value = 7;", { language: "js", cwd: process.cwd(), timeoutSeconds: 10 });
		const other = await registry
			.runtime("two")
			.execute("display(typeof value)", { language: "js", cwd: process.cwd(), timeoutSeconds: 10 });
		expect(other.output).toBe("undefined");
	} finally {
		registry.reset();
	}
});

test("Python tool output is captured by Context Guard", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-eval-capture-"));
	const core = join(cwd, "context-guard-core.js");
	const log = join(cwd, "capture.json");
	writeFileSync(
		core,
		[
			`#!${process.execPath}`,
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.on('data', chunk => input += chunk);",
			"process.stdin.on('end', () => {",
			"  const request = JSON.parse(input);",
			`  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(request));`,
			"  const output = request.params.output;",
			"  const payload = { artifactId: 'python-artifact', byteCount: output.length, lineCount: 1, preview: output };",
			"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify(payload) }] }));",
			"});",
		].join("\n"),
		"utf8",
	);
	chmodSync(core, 0o755);
	process.env.CONTEXT_GUARD_BIN = core;
	process.env.CONTEXT_GUARD_PROJECT_DIR = cwd;

	let tool: any;
	const hooks = new Map<string, (...args: any[]) => void>();
	evalExtension({
		on(name: string, handler: (...args: any[]) => void) {
			hooks.set(name, handler);
		},
		registerTool(definition: any) {
			tool = definition;
		},
	} as any);
	const result = await tool.execute("python-capture", { code: "display(42)", language: "py" }, undefined, undefined, {
		cwd,
	});
	hooks.get("session_shutdown")?.();

	expect(result.content[0].text).toBe("42");
	expect(result.details).toMatchObject({ language: "py", artifactId: "python-artifact" });
	const request = JSON.parse(readFileSync(log, "utf8"));
	expect(request.params).toMatchObject({ sourceKind: "eval", metadata: { language: "py" }, output: "42" });
});

test("runtime errors retain partial output", async () => {
	const javascript = await execute("console.log('before'); throw new Error('boom');", "js");
	const python = await execute("print('before')\nraise RuntimeError('boom')", "py");

	expect(javascript.output).toBe("before");
	expect(javascript.error).toContain("boom");
	expect(python.output).toBe("before");
	expect(python.error).toContain("boom");
});

test("timeout force-kills the kernel and starts a fresh process", async () => {
	await expect(execute("while (true) {}", "js", process.cwd(), 0.05)).rejects.toThrow("eval timed out");
	expect((await execute("display(typeof previousValue)", "js")).output).toBe("undefined");
});

test("JavaScript process crashes do not crash the host", async () => {
	await expect(execute("process.exit(17)", "js")).rejects.toThrow("JavaScript kernel exited");
	expect((await execute("display('fresh')", "js")).output).toBe("fresh");
});

test("Python process crashes do not crash the host", async () => {
	await expect(execute("import os\nos._exit(17)", "py")).rejects.toThrow("Python kernel exited");
	expect((await execute("display('fresh')", "py")).output).toBe("fresh");
});
