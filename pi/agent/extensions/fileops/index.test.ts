import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fileopsExtension, { HASHLINE_GRAMMAR, PATCH_GRAMMAR, REPLACE_GRAMMAR } from "./index.ts";

const originalVariant = process.env.PI_FILEOPS_EDIT_VARIANT;

afterEach(() => {
	if (originalVariant === undefined) delete process.env.PI_FILEOPS_EDIT_VARIANT;
	else process.env.PI_FILEOPS_EDIT_VARIANT = originalVariant;
	delete process.env.PI_EDIT_VARIANT;
});

function registerEditTool(mode: string): any {
	process.env.PI_FILEOPS_EDIT_VARIANT = mode;
	let tool: any;
	fileopsExtension({
		registerTool: (definition: any) => {
			if (definition.name === "edit") tool = definition;
		},
		registerCommand: () => {},
	} as any);
	return tool;
}

function registerEditTools(mode: string): Map<string, any> {
	process.env.PI_FILEOPS_EDIT_VARIANT = mode;
	const tools = new Map<string, any>();
	fileopsExtension({
		registerTool: (definition: any) => {
			tools.set(definition.name, definition);
		},
		registerCommand: () => {},
	} as any);
	return tools;
}

function registerEditCommand(mode = "apply_patch"): any {
	process.env.PI_FILEOPS_EDIT_VARIANT = mode;
	let command: any;
	fileopsExtension({
		registerTool: () => {},
		registerCommand: (name: string, definition: any) => {
			if (name === "edit-config") command = definition;
		},
	} as any);
	return command;
}

describe("fileops extension modes", () => {
	it("starts in apply_patch mode and applies freeform envelopes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-apply-patch-"));
		const tool = registerEditTool("apply_patch");

		await tool.execute(
			"call",
			{
				input: "*** Begin Patch\n*** Add File: sample.txt\n+hello\n*** End Patch\n",
			},
			undefined,
			undefined,
			{ cwd },
		);

		expect(tool.parameters.properties.input).toBeDefined();
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("hello\n");
	});

	it("supports patch mode create/update/delete envelopes from entries", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-patch-"));
		const tool = registerEditTool("patch");

		await tool.execute("call", { input: "*** File: sample.txt\n*** Create\n+hello\n" }, undefined, undefined, {
			cwd,
		});
		await tool.execute(
			"call",
			{ input: "*** File: sample.txt\n*** Update\n@@\n-hello\n+hi\n" },
			undefined,
			undefined,
			{ cwd },
		);

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("hi\n");
	});

	it("supports hashline mode", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-"));
		const original = "hello\nworld\n";
		writeFileSync(join(cwd, "sample.txt"), original);
		const tools = registerEditTools("hashline");
		const read = tools.get("read");
		const tool = tools.get("edit");
		const readResult = await read.execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await tool.execute("call", { input: `${header}\n1 1\n+hi\n+there\n2 2\n&2\n` }, undefined, undefined, { cwd });

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("hi\nthere\nworld\n");
	});

	it("hashline read emits snapshot headers and write strips copied display prefixes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-workflow-"));
		writeFileSync(join(cwd, "sample.txt"), "first\nsecond\n");
		const tools = registerEditTools("hashline");

		const readResult = await tools
			.get("read")
			.execute("read", { path: "sample.txt", offset: 1, limit: 2 }, undefined, undefined, { cwd });
		expect(readResult.content[0].text).toMatch(/^¶sample\.txt#[0-9A-F]{3}\n1:first\n2:second/);

		await tools
			.get("write")
			.execute("write", { path: "copy.txt", content: readResult.content[0].text }, undefined, undefined, { cwd });
		expect(readFileSync(join(cwd, "copy.txt"), "utf-8")).toBe("first\nsecond");
	});

	it("hashline read supports path line selectors and sparse anchored edits", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-selector-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\nthree\nfour\n");
		const tools = registerEditTools("hashline");

		const readResult = await tools
			.get("read")
			.execute("read", { path: "sample.txt:2-3" }, undefined, undefined, { cwd });
		expect(readResult.content[0].text).toMatch(/^¶sample\.txt#[0-9A-F]{3}\n2:two\n3:three/);
		const header = readResult.content[0].text.split("\n")[0];

		await tools
			.get("edit")
			.execute("call", { input: `${header}\n2 2\n+TWO\n3 3\n&3\n` }, undefined, undefined, { cwd });
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\nTWO\nthree\nfour\n");
	});

	it("hashline edit uses upstream recovery for unrelated external writes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-recovery-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\nthree\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];
		writeFileSync(join(cwd, "sample.txt"), "zero\none\ntwo\nthree\n");

		const result = await tools
			.get("edit")
			.execute("call", { input: `${header}\n2 2\n+TWO\n` }, undefined, undefined, { cwd });

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("zero\none\nTWO\nthree\n");
		expect(result.content[0].text).toContain("Recovered");
	});

	it("hashline edit rejects unsafe stale snapshots without changing the file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-stale-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\nthree\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];
		writeFileSync(join(cwd, "sample.txt"), "one\nexternal\nthree\n");

		await expect(
			tools.get("edit").execute("call", { input: `${header}\n2 2\n+TWO\n` }, undefined, undefined, { cwd }),
		).rejects.toThrow("file changed between read and edit");
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\nexternal\nthree\n");
	});

	it("hashline edit preflights multi-section patches before writing any file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-atomic-"));
		writeFileSync(join(cwd, "first.txt"), "a\nb\n");
		writeFileSync(join(cwd, "second.txt"), "x\ny\n");
		const tools = registerEditTools("hashline");
		const firstHeader = (
			await tools.get("read").execute("read", { path: "first.txt" }, undefined, undefined, { cwd })
		).content[0].text.split("\n")[0];
		const secondHeader = (
			await tools.get("read").execute("read", { path: "second.txt" }, undefined, undefined, { cwd })
		).content[0].text.split("\n")[0];

		await expect(
			tools
				.get("edit")
				.execute("call", { input: `${firstHeader}\n1 1\n+A\n${secondHeader}\n99 99\n+Z\n` }, undefined, undefined, {
					cwd,
				}),
		).rejects.toThrow("Line 99 does not exist");
		expect(readFileSync(join(cwd, "first.txt"), "utf-8")).toBe("a\nb\n");
		expect(readFileSync(join(cwd, "second.txt"), "utf-8")).toBe("x\ny\n");
	});

	it("hashline edit preserves BOM and CRLF line endings", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-crlf-"));
		writeFileSync(join(cwd, "sample.txt"), "\uFEFFone\r\ntwo\r\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await tools.get("edit").execute("call", { input: `${header}\n2 2\n+TWO\n` }, undefined, undefined, { cwd });

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("\uFEFFone\r\nTWO\r\n");
	});

	it("hashline edit supports hashless BOF creation and surfaces parser warnings", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-create-warning-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\n");
		const tools = registerEditTools("hashline");

		await tools.get("edit").execute("call", { input: "¶created.txt\nBOF\n+hello\n" }, undefined, undefined, { cwd });
		expect(readFileSync(join(cwd, "created.txt"), "utf-8")).toBe("hello");

		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];
		const result = await tools
			.get("edit")
			.execute("call", { input: `${header}\n2 2\n+&1\n` }, undefined, undefined, { cwd });
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\none\n");
		expect(result.content[0].text).toContain("Warnings:");
		expect(result.content[0].text).toContain("Treated as `&A..B`");
	});

	it("registers search and find workflow tools", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-search-"));
		writeFileSync(join(cwd, "sample.txt"), "alpha\nbeta\n");
		const tools = registerEditTools("hashline");

		const searchResult = await tools
			.get("search")
			.execute("search", { pattern: "beta", path: "sample.txt" }, undefined, undefined, { cwd });
		expect(searchResult.content[0].text).toContain("¶sample.txt#");
		expect(searchResult.content[0].text).toContain("2:beta");
		expect(tools.get("find").parameters.properties.paths).toBeDefined();
	});

	it("supports replace mode snake-case and all true", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-replace-"));
		writeFileSync(join(cwd, "sample.txt"), "foo bar foo\nfoo\n");
		const tool = registerEditTool("replace");

		const result = await tool.execute(
			"call",
			{ input: "*** File: sample.txt\n*** Old\n|foo\n*** New\n|baz\n*** All\n" },
			undefined,
			undefined,
			{ cwd },
		);

		expect(result.content[0].text).toContain("3 occurrences");
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("baz bar baz\nbaz\n");
	});

	it("completes edit-config mode arguments by prefix", () => {
		const command = registerEditCommand();

		expect(command.getArgumentCompletions("")).toEqual([
			{ value: "apply_patch", label: "apply_patch" },
			{ value: "patch", label: "patch" },
			{ value: "hashline", label: "hashline" },
			{ value: "replace", label: "replace" },
		]);
		expect(command.getArgumentCompletions("ha")).toEqual([{ value: "hashline", label: "hashline" }]);
		expect(command.getArgumentCompletions(" nope")).toBeNull();
	});

	it("has a dedicated grammar for every non-apply_patch mode", () => {
		expect(PATCH_GRAMMAR).toContain("*** Create");
		expect(HASHLINE_GRAMMAR).toContain("body_range");
		expect(REPLACE_GRAMMAR).toContain("*** Old");
	});

	it("loads hashline grammar from the standalone OMP grammar file", () => {
		expect(HASHLINE_GRAMMAR).toBe(readFileSync(join(import.meta.dir, "hashline", "grammar.lark"), "utf-8"));
	});
});
