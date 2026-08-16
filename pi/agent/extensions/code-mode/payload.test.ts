import { expect, it } from "bun:test";
import { nothingToRunReason, prepareCellArguments, preprocessRawBlockLiterals } from "./payload.ts";

// Only one of the two payload shapes is exercised per session, so a regression on the other is invisible until someone
// switches models mid-task and every cell runs with the wrong options, or with its pragma as line one.
it("reads options off the pragma of a freeform payload", () => {
	const code = 'const s = `a "b"\nc`;\nconsole.log(s);';

	expect(prepareCellArguments({ code: `// @exec: {"runtime": "bun", "yield_time_ms": 500}\n${code}` })).toEqual({
		code,
		yield_time_ms: 500,
	});
	expect(prepareCellArguments(code)).toEqual({ code });
});

it("turns raw edit blocks into strings without escaping patch source", () => {
	const interpolation = "${" + "name}";
	const source = [
		"const result = tools.edit(@`",
		"[src/a.ts#ABCD]",
		"replace 1..1:",
		`+const value = \`${interpolation}\\\\path\`;`,
		"`@);",
	].join("\n");
	const transformed = preprocessRawBlockLiterals(source);
	const result = new Function("tools", `${transformed}\nreturn result;`)({
		edit: (input: string) => input,
	});

	expect(transformed.split("\n")).toHaveLength(source.split("\n").length);
	expect(result).toBe(`[src/a.ts#ABCD]\nreplace 1..1:\n+const value = \`${interpolation}\\\\path\`;\n`);
});

it("ignores removed live runtime controls on sibling keys", () => {
	expect(prepareCellArguments({ code: "console.log(1)", runtime: "bun", reset: true, yield_time_ms: 500 })).toEqual({
		code: "console.log(1)",
		yield_time_ms: 500,
	});
});

it("drops an unparseable pragma line without taking the program with it", () => {
	expect(prepareCellArguments({ code: '// @exec: {"langua\nconsole.log(1);' })).toEqual({ code: "console.log(1);" });
	expect(prepareCellArguments({ code: '// @exec: {"yield_time_ms": "500", "reset": true}\nx' })).toEqual({
		code: "x",
		yield_time_ms: 500,
	});
});

it("keeps only declared options", () => {
	expect(prepareCellArguments({ code: '// @exec: {"title": "hi", "language": "js"}\nx' })).toEqual({
		code: "x",
		language: "js",
	});
});

// This shipped because nothing asserted that a wrong shape fails. Live, `exec({cmd: "grep -RIn Error crates"})` ran an
// empty cell, returned "Cell 1 completed", and the model answered "It printed 0 lines" as a fact.
it.each([
	["cmd, the shape observed live", { cmd: "grep -RIn Error crates", yield_time_ms: 10_000 }],
	["command", { command: "ls -la" }],
	["script", { script: "console.log(1)" }],
	["source", { source: "console.log(1)" }],
	["input", { input: "console.log(1)" }],
	["no arguments at all", {}],
	["a non-string code", { code: 123 }],
	["a whitespace-only code", { code: "   \n\t" }],
])("refuses to run and explains the shape when given %s", (_label, args) => {
	const reason = nothingToRunReason(prepareCellArguments(args));

	expect(reason).toContain("exec ran nothing");
	expect(reason).toContain("`code`");
	expect(reason).toContain("tools.exec_command");
});

it("runs only a real cell body", () => {
	expect(nothingToRunReason(prepareCellArguments({ code: "console.log(1)" }))).toBeUndefined();
	expect(nothingToRunReason(prepareCellArguments("console.log(1)"))).toBeUndefined();
	expect(nothingToRunReason(prepareCellArguments({ reset: true }))).toContain("exec ran nothing");
});
