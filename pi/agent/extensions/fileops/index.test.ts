import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { visibleWidth } from "@earendil-works/pi-tui";
import fileopsExtension, { HASHLINE_GRAMMAR, PATCH_GRAMMAR, REPLACE_GRAMMAR } from "./index.ts";

const originalVariant = process.env.PI_FILEOPS_EDIT_VARIANT;
const originalAutoDropPureInsertDuplicates = process.env.PI_FILEOPS_HASHLINE_AUTO_DROP_PURE_INSERT_DUPLICATES;
const theme = {
	fg(_role: string, text: string) {
		return text;
	},
	bg(role: string, text: string) {
		return `[${role}]${text}[/]`;
	},
	bold(text: string) {
		return `**${text}**`;
	},
	inverse(text: string) {
		return `<inv>${text}</inv>`;
	},
	styledSymbol(name: string) {
		return name === "status.success" ? "✓" : name === "status.error" ? "✗" : "∙";
	},
	getLangIcon() {
		return "≡";
	},
	tree: { last: "└─", branch: "├─", vertical: "│" },
};

const roleTheme = {
	...theme,
	fg(role: string, text: string) {
		return `<${role}>${text}</${role}>`;
	},
};

afterEach(() => {
	if (originalVariant === undefined) delete process.env.PI_FILEOPS_EDIT_VARIANT;
	else process.env.PI_FILEOPS_EDIT_VARIANT = originalVariant;
	delete process.env.PI_EDIT_VARIANT;
	if (originalAutoDropPureInsertDuplicates === undefined) {
		delete process.env.PI_FILEOPS_HASHLINE_AUTO_DROP_PURE_INSERT_DUPLICATES;
	} else {
		process.env.PI_FILEOPS_HASHLINE_AUTO_DROP_PURE_INSERT_DUPLICATES = originalAutoDropPureInsertDuplicates;
	}
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

function registerEditToolWithEvents(mode: string): {
	tool: any;
	tools: Map<string, any>;
	emit: (event: string, payload: any, ctx?: any) => void;
} {
	process.env.PI_FILEOPS_EDIT_VARIANT = mode;
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
	fileopsExtension({
		registerTool: (definition: any) => {
			tools.set(definition.name, definition);
		},
		registerCommand: () => {},
		on: (event: string, handler: (event: any, ctx: any) => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any);
	return {
		tool: tools.get("edit"),
		tools,
		emit(event: string, payload: any, ctx: any = {}) {
			for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
		},
	};
}

function longUnifiedDiff(lineCount: number): string {
	const body = Array.from({ length: lineCount }, (_, index) => [`-old${index + 1}`, `+new${index + 1}`]).flat();
	return [`--- a/sample.txt`, `+++ b/sample.txt`, `@@ -1,${lineCount} +1,${lineCount} @@`, ...body, ""].join("\n");
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

function render(component: any): string {
	return component
		.render(120)
		.map((line: string) => line.trimEnd())
		.join("\n");
}

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

const rgbTheme = {
	...theme,
	getFgAnsi(role: string) {
		return role === "accent" ? "\x1b[38;2;121;184;255m" : undefined;
	},
};

const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
function charsWithBackground(text: string, background: string): string {
	let output = "";
	let active = false;
	let index = 0;
	for (const match of text.matchAll(ANSI_SGR_PATTERN)) {
		if (active) output += text.slice(index, match.index ?? 0);
		const sequence = match[0];
		const params = (match[1] ?? "").split(";").filter(Boolean);
		if (sequence === background) active = true;
		else if (params.length === 0 || params.includes("0") || params.includes("49") || params.includes("48"))
			active = false;
		index = (match.index ?? 0) + sequence.length;
	}
	if (active) output += text.slice(index);
	return output;
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

		await tool.execute("call", { input: `${header}\nreplace 1..1:\n+hi\n+there\n` }, undefined, undefined, { cwd });

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("hi\nthere\nworld\n");
	});

	it("hashline read emits snapshot headers and write strips copied display prefixes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-workflow-"));
		writeFileSync(join(cwd, "sample.txt"), "first\nsecond\nthird\n");
		const tools = registerEditTools("hashline");

		const readResult = await tools
			.get("read")
			.execute("read", { path: "sample.txt", offset: 1, limit: 2 }, undefined, undefined, { cwd });
		expect(readResult.content[0].text).toMatch(/^\[sample\.txt#[0-9A-F]{4}\]\n1:first\n2:second/);
		expect(readResult.content[0].text).toContain("[1 more line in file.");

		await tools
			.get("write")
			.execute("write", { path: "copy.txt", content: readResult.content[0].text }, undefined, undefined, { cwd });
		expect(readFileSync(join(cwd, "copy.txt"), "utf-8")).toBe("first\nsecond");
	});

	it("hashline read delegates supported images to the image-capable reader", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-image-"));
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
			"base64",
		);
		writeFileSync(join(cwd, "sample.png"), png);
		const tools = registerEditTools("hashline");

		const readResult = await tools.get("read").execute("read", { path: "sample.png" }, undefined, undefined, { cwd });

		expect(readResult.content[0].text).toStartWith("Read image file [image/png]");
		expect(readResult.content[0].text).not.toContain("[sample.png#");
	});

	it("hashline write leaves ordinary content with isolated line-number text untouched", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-write-conservative-"));
		const tools = registerEditTools("hashline");

		await tools
			.get("write")
			.execute("write", { path: "notes.txt", content: "literal\n1:not a copied read\n" }, undefined, undefined, {
				cwd,
			});

		expect(readFileSync(join(cwd, "notes.txt"), "utf-8")).toBe("literal\n1:not a copied read\n");
	});

	it("hashline read supports path line selectors and full-file anchored edits", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-selector-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\nthree\nfour\n");
		const tools = registerEditTools("hashline");

		const readResult = await tools
			.get("read")
			.execute("read", { path: "sample.txt:2", ranges: ["3-3"] }, undefined, undefined, { cwd });
		expect(readResult.content[0].text).toMatch(/^\[sample\.txt#[0-9A-F]{4}\]\n2:two\n3:three/);
		const header = readResult.content[0].text.split("\n")[0];

		await tools
			.get("edit")
			.execute("call", { input: `${header}\nreplace 2..2:\n+TWO\n` }, undefined, undefined, { cwd });
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\nTWO\nthree\nfour\n");
	});

	it("hashline edit rejects when a partial-read tag is used outside displayed lines", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-partial-authority-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\nthree\nfour\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools
			.get("read")
			.execute("read", { path: "sample.txt", ranges: ["2"] }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await expect(
			tools
				.get("edit")
				.execute("call", { input: `${header}\nreplace 4..4:\n+FOUR\n` }, undefined, undefined, { cwd }),
		).rejects.toThrow(/exact target range/);
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\ntwo\nthree\nfour\n");
	});

	it("hashline edit rejects anchors that came only from synthetic read context", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-synthetic-authority-"));
		writeFileSync(join(cwd, "sample.ts"), "function x() {\n  return 1;\n}\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools
			.get("read")
			.execute("read", { path: "sample.ts", ranges: ["1"] }, undefined, undefined, { cwd });
		const text = readResult.content[0].text;
		expect(text).toMatch(/1:function x\(\) \{/);
		expect(text).toMatch(/3:}/);
		const header = text.split("\n")[0];

		await expect(
			tools
				.get("edit")
				.execute("call", { input: `${header}\ninsert after 3:\n+const y = 2;\n` }, undefined, undefined, { cwd }),
		).rejects.toThrow(/synthetic context/);
		expect(readFileSync(join(cwd, "sample.ts"), "utf-8")).toBe("function x() {\n  return 1;\n}\n");
	});

	it("hashline snapshots are isolated across session ids", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-session-isolation-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\n");
		const tools = registerEditTools("hashline");
		const sessionA = { cwd, sessionManager: { getSessionId: () => `${cwd}:A` } };
		const sessionB = { cwd, sessionManager: { getSessionId: () => `${cwd}:B` } };
		const readResult = await tools
			.get("read")
			.execute("read", { path: "sample.txt" }, undefined, undefined, sessionA);
		const header = readResult.content[0].text.split("\n")[0];

		await expect(
			tools
				.get("edit")
				.execute("call", { input: `${header}\nreplace 2..2:\n+TWO\n` }, undefined, undefined, sessionB),
		).rejects.toThrow(/not from this session/);
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\ntwo\n");
	});

	it("hashline snapshots survive extension reloads within the same session id", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-session-reload-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\n");
		const sessionCtx = { cwd, sessionManager: { getSessionId: () => `${cwd}:same` } };
		const readTools = registerEditTools("hashline");
		const readResult = await readTools
			.get("read")
			.execute("read", { path: "sample.txt" }, undefined, undefined, sessionCtx);
		const header = readResult.content[0].text.split("\n")[0];
		const editTools = registerEditTools("hashline");

		await editTools
			.get("edit")
			.execute("call", { input: `${header}\nreplace 2..2:\n+TWO\n` }, undefined, undefined, sessionCtx);
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\nTWO\n");
	});

	it("hashline edit supports explicit before and after insertion anchors", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-insert-anchors-"));
		writeFileSync(join(cwd, "sample.txt"), "alpha\nbeta\ngamma\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await tools
			.get("edit")
			.execute(
				"call",
				{ input: `${header}\ninsert before 2:\n+before beta\ninsert after 2:\n+after beta\n` },
				undefined,
				undefined,
				{ cwd },
			);

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("alpha\nbefore beta\nbeta\nafter beta\ngamma\n");
	});

	it("ast_grep finds structural matches with metavariables", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ast-grep-"));
		writeFileSync(join(cwd, "sample.ts"), "const a = foo(1);\nconst b = foo(2);\n");
		const tools = registerEditTools("hashline");

		const result = await tools
			.get("ast_grep")
			.execute("ast", { pattern: "foo($X)", path: "sample.ts", lang: "ts" }, undefined, undefined, { cwd });

		expect(result.content[0].text).toMatch(/^\[sample\.ts#[0-9A-F]{4}\]/);
		expect(result.content[0].text).toContain("1:const a = foo(1);");
		expect(result.content[0].text).toContain('meta: X="1"');
	});

	it("ast_edit previews rewrites and applies with a fresh hashline tag", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ast-edit-"));
		writeFileSync(join(cwd, "sample.ts"), "const a = foo(1);\n");
		const tools = registerEditTools("hashline");
		const astEdit = tools.get("ast_edit");

		const preview = await astEdit.execute(
			"ast",
			{ pattern: "foo($X)", rewrite: "bar($X)", path: "sample.ts", lang: "ts" },
			undefined,
			undefined,
			{ cwd },
		);
		expect(preview.content[0].text).toContain("Preview: 1 rewrite(s)");
		expect(readFileSync(join(cwd, "sample.ts"), "utf-8")).toBe("const a = foo(1);\n");

		const applied = await astEdit.execute(
			"ast",
			{ pattern: "foo($X)", rewrite: "bar($X)", path: "sample.ts", lang: "ts", apply: true },
			undefined,
			undefined,
			{ cwd },
		);
		expect(readFileSync(join(cwd, "sample.ts"), "utf-8")).toBe("const a = bar(1);\n");
		const header = applied.content[0].text.split("\n")[0];
		expect(header).toMatch(/^\[sample\.ts#[0-9A-F]{4}\]/);

		await tools
			.get("edit")
			.execute("call", { input: `${header}\nreplace 1..1:\n+const a = baz(1);\n` }, undefined, undefined, { cwd });
		expect(readFileSync(join(cwd, "sample.ts"), "utf-8")).toBe("const a = baz(1);\n");
	});

	it("ast_grep reports pattern parse errors", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ast-grep-error-"));
		writeFileSync(join(cwd, "sample.ts"), "const a = foo(1);\n");
		const tools = registerEditTools("hashline");

		await expect(
			tools
				.get("ast_grep")
				.execute("ast", { pattern: "if $$$", path: "sample.ts", lang: "ts" }, undefined, undefined, { cwd }),
		).rejects.toThrow(/ast-grep failed/);
	});

	it("hashline edit can auto-drop generic pure-insert duplicate context when configured", async () => {
		process.env.PI_FILEOPS_HASHLINE_AUTO_DROP_PURE_INSERT_DUPLICATES = "true";
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-pure-insert-drop-"));
		writeFileSync(join(cwd, "sample.txt"), "aaa\nbbb\nccc\nddd\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		const result = await tools
			.get("edit")
			.execute(
				"call",
				{ input: `${header}\ninsert after 2:\n+aaa\n+bbb\n+NEW\n+ccc\n+ddd\n` },
				undefined,
				undefined,
				{ cwd },
			);

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("aaa\nbbb\nNEW\nccc\nddd\n");
		expect(result.content[0].text).toContain("Auto-dropped 2 duplicate line(s) at the start of insert");
		expect(result.content[0].text).toContain("Auto-dropped 2 duplicate line(s) at the end of insert");
	});

	it("hashline after insertion preserves scope delimiters", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-scope-insert-"));
		writeFileSync(join(cwd, "sample.rs"), "#[cfg(test)]\nmod tests {\n    use super::*;\n}\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.rs" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await tools
			.get("edit")
			.execute(
				"call",
				{ input: `${header}\ninsert after 2:\n+    #[test]\n+    fn smoke() {}\n` },
				undefined,
				undefined,
				{ cwd },
			);

		expect(readFileSync(join(cwd, "sample.rs"), "utf-8")).toBe(
			"#[cfg(test)]\nmod tests {\n    #[test]\n    fn smoke() {}\n    use super::*;\n}\n",
		);
	});

	it("hashline search output can drive full-file anchored edits", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-search-edit-"));
		writeFileSync(join(cwd, "sample.txt"), "alpha\nbeta\ngamma\n");
		const tools = registerEditTools("hashline");

		const searchResult = await tools
			.get("search")
			.execute("search", { pattern: "beta", path: "sample.txt", context: 1 }, undefined, undefined, { cwd });
		expect(searchResult.content[0].text).toMatch(/^\[sample\.txt#[0-9A-F]{4}\]\n 1:alpha\n\*2:beta\n 3:gamma/);
		const header = searchResult.content[0].text.split("\n")[0];

		await tools
			.get("edit")
			.execute("call", { input: `${header}\nreplace 3..3:\n+GAMMA\n` }, undefined, undefined, { cwd });

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("alpha\nbeta\nGAMMA\n");
	});

	it("hashline search highlights regex alternatives in matched rows", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-search-regex-highlight-"));
		writeFileSync(join(cwd, "sample.txt"), "alpha\nbeta\ngamma\n");
		const tools = registerEditTools("hashline");

		const searchResult = await tools
			.get("search")
			.execute("search", { pattern: "alpha|gamma", path: "sample.txt" }, undefined, undefined, { cwd });
		const highlightedRows = searchResult.details.highlightedSections[0].rows;

		expect(charsWithBackground(highlightedRows[0], "\x1b[48;2;92;78;35m")).toBe("alpha");
		expect(charsWithBackground(highlightedRows[1], "\x1b[48;2;92;78;35m")).toBe("gamma");
	});

	it("hashline search supports file line selectors", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-search-range-"));
		writeFileSync(join(cwd, "sample.txt"), "needle one\nskip\nneedle two\n");
		const tools = registerEditTools("hashline");

		const searchResult = await tools
			.get("search")
			.execute("search", { pattern: "needle", path: "sample.txt:3-3" }, undefined, undefined, { cwd });

		expect(searchResult.content[0].text).toContain("*3:needle two");
		expect(searchResult.content[0].text).not.toContain("1:needle one");
	});

	it("hashline write invalidates previous snapshots", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-write-invalidates-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await tools.get("write").execute("write", { path: "sample.txt", content: "one\ntwo\n" }, undefined, undefined, {
			cwd,
		});

		await expect(
			tools
				.get("edit")
				.execute("call", { input: `${header}\nreplace 2..2:\n+TWO\n` }, undefined, undefined, { cwd }),
		).rejects.toThrow("is not from this session");
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
			.execute("call", { input: `${header}\nreplace 2..2:\n+TWO\n` }, undefined, undefined, { cwd });

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
			tools
				.get("edit")
				.execute("call", { input: `${header}\nreplace 2..2:\n+TWO\n` }, undefined, undefined, { cwd }),
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
				.execute(
					"call",
					{ input: `${firstHeader}\nreplace 1..1:\n+A\n${secondHeader}\nreplace 99..99:\n+Z\n` },
					undefined,
					undefined,
					{ cwd },
				),
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

		await tools
			.get("edit")
			.execute("call", { input: `${header}\nreplace 2..2:\n+TWO\n` }, undefined, undefined, { cwd });

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("\uFEFFone\r\nTWO\r\n");
	});

	it("hashline edit refuses to create files and points at the write tool", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-no-create-"));
		const tools = registerEditTools("hashline");

		await expect(
			tools
				.get("edit")
				.execute("call", { input: "[created.txt#0A3B]\ninsert head:\n+hello\n" }, undefined, undefined, {
					cwd,
				}),
		).rejects.toThrow(/File not found.*write tool/s);
	});

	it("hashline edit requires the snapshot tag on every section", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-tag-required-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\n");
		const tools = registerEditTools("hashline");

		await expect(
			tools.get("edit").execute("call", { input: "[sample.txt]\ninsert head:\n+zero\n" }, undefined, undefined, {
				cwd,
			}),
		).rejects.toThrow("Missing hashline snapshot tag");
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\ntwo\n");
	});

	it("hashline edit treats an empty replace hunk as a range delete", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-empty-replace-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\nthree\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await tools.get("edit").execute("call", { input: `${header}\nreplace 2..3:\n` }, undefined, undefined, { cwd });

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\n");
	});

	it("hashline edit supports delete range hunks", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-explicit-delete-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\nthree\nfour\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await tools.get("edit").execute("call", { input: `${header}\ndelete 2..3\n` }, undefined, undefined, { cwd });

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\nfour\n");
	});

	it("hashline edit rejects bare numeric hunk headers with verb guidance", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-bare-header-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\nthree\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await expect(
			tools.get("edit").execute("call", { input: `${header}\n2 2\n+TWO\n` }, undefined, undefined, { cwd }),
		).rejects.toThrow(/[Hh]unk headers need a verb/);
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\ntwo\nthree\n");
	});

	it("hashline edit auto-absorbs duplicated structural closers and surfaces the warning", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-boundary-repair-"));
		writeFileSync(join(cwd, "sample.ts"), "it('a', () => {\n\tsetup();\n\trun();\n});\nafter();\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.ts" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		const result = await tools
			.get("edit")
			.execute(
				"call",
				{ input: `${header}\nreplace 2..3:\n+\tsetup2();\n+\trun2();\n+});\n` },
				undefined,
				undefined,
				{ cwd },
			);

		expect(readFileSync(join(cwd, "sample.ts"), "utf-8")).toBe(
			"it('a', () => {\n\tsetup2();\n\trun2();\n});\nafter();\n",
		);
		expect(result.content[0].text).toContain("Warnings:");
		expect(result.content[0].text).toContain(
			"dropped 1 duplicated trailing payload line(s) already present below the range",
		);
	});

	it("hashline edit resolves replace block spans through tree-sitter and echoes them", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-block-"));
		writeFileSync(
			join(cwd, "sample.ts"),
			'function greet(name: string) {\n\treturn "hi " + name;\n}\nconst x = 1;\n',
		);
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.ts" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		const result = await tools.get("edit").execute(
			"call",
			{
				input: `${header}\nreplace block 1:\n+function greet(name: string) {\n+\treturn "hello " + name;\n+}\n`,
			},
			undefined,
			undefined,
			{ cwd },
		);

		expect(readFileSync(join(cwd, "sample.ts"), "utf-8")).toBe(
			'function greet(name: string) {\n\treturn "hello " + name;\n}\nconst x = 1;\n',
		);
		expect(result.content[0].text).toContain("replace block 1 → resolved lines 1-3 (3 lines)");
	});

	it("hashline edit reports a no-op apply with the re-read diagnostic", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-noop-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		const result = await tools
			.get("edit")
			.execute("call", { input: `${header}\nreplace 2..2:\n+two\n` }, undefined, undefined, { cwd });

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\ntwo\n");
		expect(result.content[0].text).toContain("produced no change");
		expect(result.content[0].text).toContain("re-read the file");
	});

	it("protects large whole-file reads from entering context", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-large-read-"));
		writeFileSync(join(cwd, "large.log"), `${"x".repeat(60_000)}\n`);
		const tools = registerEditTools("hashline");

		const result = await tools.get("read").execute("read", { path: "large.log" }, undefined, undefined, { cwd });
		const text = result.content[0].text;

		expect(text).toContain("Large file read blocked");
		expect(text).toContain("cg_process_file");
		expect(text.length).toBeLessThan(2_000);
		expect(text).not.toContain("x".repeat(1_000));
	});

	it("allows bounded reads from large files for edit targeting", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-bounded-large-read-"));
		writeFileSync(join(cwd, "large.log"), `${"x".repeat(60_000)}\nneedle\n`);
		const tools = registerEditTools("hashline");

		const result = await tools
			.get("read")
			.execute("read", { path: "large.log", ranges: ["2"] }, undefined, undefined, { cwd });

		expect(result.content[0].text).toMatch(/^\[large\.log#[0-9A-F]{4}\]\n2:needle/);
	});

	it("caps search output globally and points large explorations at indexed search", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-search-cap-"));
		writeFileSync(
			join(cwd, "large.txt"),
			Array.from({ length: 205 }, (_, index) => `needle ${index + 1}`).join("\n"),
		);
		const tools = registerEditTools("hashline");

		const result = await tools.get("search").execute("search", { pattern: "needle" }, undefined, undefined, { cwd });
		const text = result.content[0].text;

		expect((text.match(/\*?\d+:needle/g) ?? []).length).toBe(200);
		expect(text).toContain("Search results truncated at 200 rows");
		expect(text).toContain("cg_index");
		expect(text).toContain("cg_search");
	});

	it("caps find output and reports when additional files were omitted", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-find-cap-"));
		for (let index = 0; index < 205; index++)
			writeFileSync(join(cwd, `file-${String(index).padStart(3, "0")}.txt`), "");
		const tools = registerEditTools("hashline");

		const result = await tools.get("find").execute("find", { paths: ["*.txt"] }, undefined, undefined, { cwd });
		const text = result.content[0].text;

		expect(text.split("\n").filter((line: string) => line.endsWith(".txt"))).toHaveLength(200);
		expect(text).toContain("Find results truncated at 200 files");
	});

	it("registers search and find workflow tools", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-search-"));
		writeFileSync(join(cwd, "sample.txt"), "alpha\nbeta\n");
		writeFileSync(join(cwd, "other.txt"), "alpha\n");
		const tools = registerEditTools("hashline");

		const searchResult = await tools
			.get("search")
			.execute("search", { pattern: "beta", path: "sample.txt" }, undefined, undefined, { cwd });
		expect(searchResult.content[0].text).toContain("[sample.txt#");
		expect(searchResult.content[0].text).toContain("2:beta");
		expect(tools.get("find").parameters.properties.paths).toBeDefined();
		const findResult = await tools
			.get("find")
			.execute("find", { paths: ["*.txt"], limit: 1 }, undefined, undefined, { cwd });
		expect(findResult.content[0].text).toBe("other.txt");
		const absoluteFindResult = await tools
			.get("find")
			.execute("find", { paths: [join(cwd, "*.txt")], limit: 10 }, undefined, undefined, { cwd });
		expect(absoluteFindResult.content[0].text).toBe("other.txt\nsample.txt");
		const missingRootResult = await tools
			.get("find")
			.execute("find", { paths: ["missing-root/**"], limit: 10 }, undefined, undefined, { cwd });
		expect(missingRootResult.content[0].text).toBe("No files found matching pattern");
	});

	it("renders file workflow tools in the OMP transcript shape", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-render-"));
		writeFileSync(join(cwd, "sample.txt"), "alpha\nneedle beta\ngamma\n");
		const tools = registerEditTools("hashline");

		const read = tools.get("read");
		const readResult = await read.execute("read", { path: "sample.txt:1-3" }, undefined, undefined, { cwd });
		expect(render(read.renderCall({ path: "sample.txt:1-3" }, theme, {}))).toBe("✓ **Read** sample.txt:1-3");
		expect(render(read.renderResult(readResult, { expanded: false, isPartial: false }, theme, {}))).toBe("");
		const readRendered = render(read.renderResult(readResult, { expanded: true, isPartial: false }, theme, {}));
		expect(readRendered).toContain("[sample.txt#");
		const readRoleRendered = render(
			read.renderResult(readResult, { expanded: true, isPartial: false }, roleTheme, {}),
		);
		expect(readRoleRendered).toMatch(/<accent>\[sample\.txt<\/accent><toolDiffAdded>#[0-9A-F]{4}\]<\/toolDiffAdded>/);
		expect(readRendered.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).toContain("  1│alpha");

		const search = tools.get("search");
		const searchArgs = { pattern: "needle", path: "sample.txt" };
		const searchResult = await search.execute("search", searchArgs, undefined, undefined, { cwd });
		const searchRendered = render(
			search.renderResult(searchResult, { expanded: false, isPartial: false }, theme, { args: searchArgs }),
		);
		expect(searchRendered).toContain("✓ **Search:** needle 1 match · 1 file · in sample.txt");
		expect(searchRendered).toContain("[sample.txt#");
		expect(searchRendered).toContain("*  2│");
		expect(searchRendered).toContain("needle");
		expect(searchRendered).toContain("beta");
		const searchRoleRendered = render(
			search.renderResult(searchResult, { expanded: false, isPartial: false }, roleTheme, { args: searchArgs }),
		);
		expect(searchRoleRendered).toContain("<warning>needle</warning>");
		const noMatchResult = await search.execute(
			"search",
			{ pattern: "absent", path: "sample.txt" },
			undefined,
			undefined,
			{ cwd },
		);
		const noMatchRendered = render(
			search.renderResult(noMatchResult, { expanded: false, isPartial: false }, theme, {
				args: { pattern: "absent", path: "sample.txt" },
			}),
		);
		expect(noMatchRendered).toContain("✓ **Search:** absent No matches found · in sample.txt");

		const find = tools.get("find");
		const findArgs = { paths: ["*.txt"] };
		const findResult = await find.execute("find", findArgs, undefined, undefined, { cwd });
		expect(render(find.renderCall(findArgs, theme, {}))).toBe("");
		const findRendered = render(
			find.renderResult(findResult, { expanded: false, isPartial: false }, theme, { args: findArgs }),
		);
		expect(findRendered).toContain("✓ **Find:** *.txt 1 file · in .");
		const findRoleRendered = render(
			find.renderResult(findResult, { expanded: false, isPartial: false }, roleTheme, { args: findArgs }),
		);
		expect(findRoleRendered).toContain("<warning>*.txt</warning>");
		expect(findRendered).toContain("└─ ≡ sample.txt");

		const edit = tools.get("edit");
		const header = readResult.content[0].text.split("\n")[0];
		const editContext = {
			state: {},
			invalidate: () => {
				throw new Error("edit render should not self-invalidate");
			},
		};
		const editCallRendered = render(
			edit.renderCall({ input: `${header}\nreplace 2..2:\n+needle delta\n` }, theme, editContext),
		);
		expect(editCallRendered).toContain(`✓ **Edit:** ≡ ${header}:2`);
		const editCallRoleRendered = render(
			edit.renderCall({ input: `${header}\nreplace 2..2:\n+needle delta\n` }, roleTheme, editContext),
		);
		expect(editCallRoleRendered).toMatch(
			/<accent>\[sample\.txt<\/accent><toolDiffAdded>#[0-9A-F]{4}\]<\/toolDiffAdded><warning>:2<\/warning>/,
		);
		expect(editCallRendered).toContain("[toolPendingBg]");
		expect(editCallRendered).toStartWith("[toolPendingBg]✓");
		const runningState: Record<string, any> = {};
		const runningContext = { state: runningState, isPartial: true, invalidate() {} };
		const runningEarly = render(
			edit.renderCall({ input: `${header}\nreplace 2..2:\n+needle delta\n` }, rgbTheme, runningContext),
		);
		if (runningState.elapsedTimer) clearTimeout(runningState.elapsedTimer);
		runningState.elapsedTimer = undefined;
		runningState.startedAtMs = Date.now() - 240;
		const runningLater = render(
			edit.renderCall({ input: `${header}\nreplace 2..2:\n+needle delta\n` }, rgbTheme, runningContext),
		);
		if (runningState.elapsedTimer) clearTimeout(runningState.elapsedTimer);
		expect(stripAnsi(runningEarly)).toContain(`**Editing** ≡ ${header}:2`);
		expect(stripAnsi(runningLater)).toContain(`**Editing** ≡ ${header}:2`);
		expect(stripAnsi(runningLater)).toContain("⠹");
		expect(runningEarly).not.toBe(runningLater);

		const editResult = await edit.execute(
			"edit",
			{ input: `${header}\nreplace 2..2:\n+needle delta\n` },
			undefined,
			undefined,
			{
				cwd,
			},
		);
		const editRendered = render(edit.renderResult(editResult, { expanded: true, isPartial: false }, theme, {}));
		expect(stripAnsi(editRendered)).toContain("delta");
		expect(stripAnsi(editRendered)).not.toContain("✓ **Edit:**");
		expect(editRendered).not.toContain("[toolSuccessBg]");
		const wideEditLines = edit
			.renderResult(editResult, { expanded: true, isPartial: false }, rgbTheme, {})
			.render(237);
		expect(wideEditLines.every((line: string) => visibleWidth(line) <= 237)).toBe(true);

		const write = tools.get("write");
		const writeRendered = render(write.renderCall({ path: "out.txt", content: "one\ntwo" }, theme, {}));
		expect(writeRendered).toContain("✓ **Write:** ≡ out.txt · 2 lines");
		expect(writeRendered).toContain("1│one");
		expect(writeRendered).toContain("2│two");
		expect(writeRendered).not.toContain("[toolSuccessBg]");
	});

	it("does not expand edit diffs from older turns", () => {
		const { tool, emit } = registerEditToolWithEvents("hashline");
		const result = {
			content: [{ type: "text", text: "[sample.txt#ABCD]" }],
			details: { diff: longUnifiedDiff(60), editTurnIndex: 1 },
		};

		emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
		emit("tool_execution_start", {
			type: "tool_execution_start",
			toolName: "edit",
			toolCallId: "turn-1-edit",
			args: {},
		});
		const staleComponent = tool.renderResult(result, { expanded: true, isPartial: false }, theme, {
			toolCallId: "turn-1-edit",
			executionStarted: true,
		});
		const latestRendered = stripAnsi(render(staleComponent));
		expect(latestRendered).toContain("new60");

		emit("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 2 });
		const stillLatestRendered = stripAnsi(render(staleComponent));
		expect(stillLatestRendered).toContain("new60");

		emit("session_start", { type: "session_start", reason: "reload" });
		const replayedComponent = tool.renderResult(result, { expanded: true, isPartial: false }, theme, {
			toolCallId: "turn-1-edit",
			executionStarted: false,
		});
		expect(stripAnsi(render(replayedComponent))).toBe("");

		emit("turn_start", { type: "turn_start", turnIndex: 3, timestamp: 3 });
		emit("tool_execution_start", {
			type: "tool_execution_start",
			toolName: "edit",
			toolCallId: "turn-2-edit",
			args: {},
		});
		expect(stripAnsi(render(staleComponent))).toBe("");
		const newLatestResult = { ...result, details: { ...result.details, editTurnIndex: 3 } };
		const newLatestRendered = stripAnsi(
			render(
				tool.renderResult(newLatestResult, { expanded: true, isPartial: false }, theme, {
					toolCallId: "turn-2-edit",
					executionStarted: true,
				}),
			),
		);
		expect(newLatestRendered).toContain("new60");
	});

	it("does not expand no-diff edit text from older turns", () => {
		const { tool, emit } = registerEditToolWithEvents("apply_patch");
		const result = {
			content: [
				{
					type: "text",
					text: Array.from({ length: 60 }, (_, index) => `text fallback line ${index + 1}`).join("\n"),
				},
			],
			details: { editTurnIndex: 1 },
		};

		emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
		emit("tool_execution_start", {
			type: "tool_execution_start",
			toolName: "edit",
			toolCallId: "turn-1-edit",
			args: {},
		});
		const staleComponent = tool.renderResult(result, { expanded: true, isPartial: false }, theme, {
			toolCallId: "turn-1-edit",
			executionStarted: true,
		});
		expect(stripAnsi(render(staleComponent))).toContain("text fallback line 60");

		emit("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 2 });
		expect(stripAnsi(render(staleComponent))).toContain("text fallback line 60");
		emit("tool_execution_start", {
			type: "tool_execution_start",
			toolName: "edit",
			toolCallId: "turn-2-edit",
			args: {},
		});
		expect(stripAnsi(render(staleComponent))).toBe("");
	});

	it("does not render search or find results from older turns", () => {
		const { tools, emit } = registerEditToolWithEvents("hashline");
		const search = tools.get("search");
		const find = tools.get("find");
		const searchResult = { content: [{ type: "text", text: "[sample.txt#ABCD]\n*1:needle" }], details: {} };
		const findResult = { content: [{ type: "text", text: "sample.txt\nother.txt" }], details: {} };

		emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 1 });
		emit("tool_execution_start", {
			type: "tool_execution_start",
			toolName: "search",
			toolCallId: "search-1",
			args: {},
		});
		emit("tool_execution_start", { type: "tool_execution_start", toolName: "find", toolCallId: "find-1", args: {} });
		const searchComponent = search.renderResult(searchResult, { expanded: true, isPartial: false }, theme, {
			args: { pattern: "needle", path: "." },
			toolCallId: "search-1",
			executionStarted: true,
		});
		const findComponent = find.renderResult(findResult, { expanded: true, isPartial: false }, theme, {
			args: { paths: ["*.txt"] },
			toolCallId: "find-1",
			executionStarted: true,
		});
		expect(stripAnsi(render(searchComponent))).toContain("needle");
		expect(stripAnsi(render(findComponent))).toContain("sample.txt");

		emit("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 2 });
		expect(stripAnsi(render(searchComponent))).toContain("needle");
		expect(stripAnsi(render(findComponent))).toContain("sample.txt");
		emit("tool_execution_start", {
			type: "tool_execution_start",
			toolName: "search",
			toolCallId: "search-2",
			args: {},
		});
		expect(stripAnsi(render(searchComponent))).toBe("");
		expect(stripAnsi(render(findComponent))).toBe("");
	});

	it("renders all replayed fileops results from the latest assistant turn", () => {
		const { tools, emit } = registerEditToolWithEvents("hashline");
		const search = tools.get("search");
		const find = tools.get("find");
		const olderSearchResult = { content: [{ type: "text", text: "[old.txt#ABCD]\n*1:old" }], details: {} };
		const latestSearchResult = { content: [{ type: "text", text: "[new.txt#ABCD]\n*1:needle" }], details: {} };
		const latestFindResult = { content: [{ type: "text", text: "new.txt\nother.txt" }], details: {} };
		const ctx = {
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "toolCall", id: "old-search", name: "search", arguments: {} }],
						},
					},
					{
						type: "message",
						message: {
							role: "assistant",
							content: [
								{ type: "toolCall", id: "latest-search", name: "search", arguments: {} },
								{ type: "toolCall", id: "latest-find", name: "find", arguments: {} },
							],
						},
					},
				],
			},
		};

		emit("session_start", { type: "session_start", reason: "reload" }, ctx);
		expect(
			stripAnsi(
				render(
					search.renderResult(olderSearchResult, { expanded: true, isPartial: false }, theme, {
						args: { pattern: "old", path: "." },
						toolCallId: "old-search",
						executionStarted: false,
					}),
				),
			),
		).toBe("");
		expect(
			stripAnsi(
				render(
					search.renderResult(latestSearchResult, { expanded: true, isPartial: false }, theme, {
						args: { pattern: "needle", path: "." },
						toolCallId: "latest-search",
						executionStarted: false,
					}),
				),
			),
		).toContain("needle");
		expect(
			stripAnsi(
				render(
					find.renderResult(latestFindResult, { expanded: true, isPartial: false }, theme, {
						args: { paths: ["*.txt"] },
						toolCallId: "latest-find",
						executionStarted: false,
					}),
				),
			),
		).toContain("new.txt");
	});

	it("renders independent file sections in columns when width allows", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-columns-"));
		writeFileSync(join(cwd, "alpha.txt"), "needle alpha\n");
		writeFileSync(join(cwd, "beta.txt"), "needle beta\n");
		const tools = registerEditTools("hashline");

		const search = tools.get("search");
		const searchArgs = { pattern: "needle", path: "." };
		const searchResult = await search.execute("search", searchArgs, undefined, undefined, { cwd });
		const searchWideLines = search
			.renderResult(searchResult, { expanded: false, isPartial: false }, theme, { args: searchArgs })
			.render(240)
			.map(stripAnsi);
		expect(searchWideLines.some((line: string) => line.includes("[alpha.txt#") && line.includes("[beta.txt#"))).toBe(
			true,
		);

		const find = tools.get("find");
		const findArgs = { paths: ["*.txt"] };
		const findResult = await find.execute("find", findArgs, undefined, undefined, { cwd });
		const findWideLines = find
			.renderResult(findResult, { expanded: false, isPartial: false }, theme, { args: findArgs })
			.render(240)
			.map(stripAnsi);
		expect(findWideLines.some((line: string) => line.includes("alpha.txt") && line.includes("beta.txt"))).toBe(true);
	});

	it("renders multi-file edit diffs in columns when width allows", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-diff-columns-"));
		writeFileSync(join(cwd, "alpha.txt"), "alpha\n");
		writeFileSync(join(cwd, "beta.txt"), "beta\n");
		const tools = registerEditTools("hashline");
		const alphaHeader = (
			await tools.get("read").execute("read", { path: "alpha.txt" }, undefined, undefined, { cwd })
		).content[0].text.split("\n")[0];
		const betaHeader = (
			await tools.get("read").execute("read", { path: "beta.txt" }, undefined, undefined, { cwd })
		).content[0].text.split("\n")[0];

		const editResult = await tools
			.get("edit")
			.execute(
				"edit",
				{ input: `${alphaHeader}\nreplace 1..1:\n+ALPHA\n${betaHeader}\nreplace 1..1:\n+BETA\n` },
				undefined,
				undefined,
				{
					cwd,
				},
			);
		const wideLines = tools
			.get("edit")
			.renderResult(editResult, { expanded: true, isPartial: false }, theme, {})
			.render(240)
			.map(stripAnsi);

		expect(wideLines.some((line: string) => line.includes("[alpha.txt#") && line.includes("[beta.txt#"))).toBe(true);
	});

	it("renders an edit header only when an edit diff switches files", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-multi-file-render-"));
		writeFileSync(join(cwd, "sample.txt"), "alpha\nbeta\n");
		writeFileSync(join(cwd, "other.rs"), "fn smoke() {}\n");
		const tools = registerEditTools("hashline");
		const sampleHeader = (
			await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd })
		).content[0].text.split("\n")[0];
		const otherHeader = (
			await tools.get("read").execute("read", { path: "other.rs" }, undefined, undefined, { cwd })
		).content[0].text.split("\n")[0];
		const editResult = await tools
			.get("edit")
			.execute(
				"edit",
				{ input: `${sampleHeader}\nreplace 2..2:\n+BETA\n${otherHeader}\ninsert before 1:\n+use super::*;\n` },
				undefined,
				undefined,
				{ cwd },
			);

		const rendered = stripAnsi(
			render(tools.get("edit").renderResult(editResult, { expanded: true, isPartial: false }, theme, {})),
		);
		const sampleHeaderIndex = rendered.indexOf("✓ **Edit:** ≡ [sample.txt#");
		const otherHeaderIndex = rendered.indexOf("✓ **Edit:** ≡ [other.rs#");
		const otherContentIndex = rendered.indexOf("1 + use super::*;");

		expect(sampleHeaderIndex).toBe(-1);
		expect(otherHeaderIndex).toBeGreaterThanOrEqual(0);
		expect(otherContentIndex).toBeGreaterThan(otherHeaderIndex);
	});

	it("renders successful edits to files with 'error' in the name as diffs", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-error-path-name-"));
		writeFileSync(join(cwd, "error.txt"), "broken\n");
		const tools = registerEditTools("hashline");
		const header = (
			await tools.get("read").execute("read", { path: "error.txt" }, undefined, undefined, { cwd })
		).content[0].text.split("\n")[0];

		const editResult = await tools
			.get("edit")
			.execute("edit", { input: `${header}\nreplace 1..1:\n+FIXED\n` }, undefined, undefined, { cwd });
		const rendered = stripAnsi(
			render(tools.get("edit").renderResult(editResult, { expanded: true, isPartial: false }, theme, {})),
		);

		expect(rendered).toContain("1 + FIXED");
	});

	it("precomputes syntax-highlighted edit rows with word-level diff overlays", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-highlight-"));
		writeFileSync(join(cwd, "sample.ts"), "const value = 1;\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.ts" }, undefined, undefined, { cwd });
		expect(readResult.details.highlightedRows.some((row: string) => row.includes("\x1b["))).toBe(true);
		const header = readResult.content[0].text.split("\n")[0];
		const searchResult = await tools
			.get("search")
			.execute("search", { pattern: "value", path: "sample.ts" }, undefined, undefined, { cwd });
		expect(searchResult.details.highlightedSections[0].rows[0]).toContain("\x1b[48;2;92;78;35m");

		const editResult = await tools
			.get("edit")
			.execute("edit", { input: `${header}\nreplace 1..1:\n+const value = 2;\n` }, undefined, undefined, { cwd });
		const rows = editResult.details.highlightedDiffRows;

		expect(Array.isArray(rows)).toBe(true);
		expect(
			rows.some((row: any) => row.kind === "remove" && row.highlightedContent.includes("\x1b[48;2;115;55;75m1")),
		).toBe(true);
		expect(
			rows.some((row: any) => row.kind === "add" && row.highlightedContent.includes("\x1b[48;2;45;94;60m2")),
		).toBe(true);
	});

	it("highlights the minimal visible character changes inside syntax-highlighted diff rows", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-visible-char-diff-"));
		writeFileSync(join(cwd, "sample.ts"), "if (bestIndex >= 0 && bestScore >= 0.35) {\n}\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.ts" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		const editResult = await tools
			.get("edit")
			.execute(
				"edit",
				{ input: `${header}\nreplace 1..1:\n+if (bestIndex >= 0 && bestScore >= 0.65) {\n` },
				undefined,
				undefined,
				{ cwd },
			);
		const rows = editResult.details.highlightedDiffRows;
		const removed = rows.find((row: any) => row.kind === "remove");
		const added = rows.find((row: any) => row.kind === "add");

		expect(charsWithBackground(removed.highlightedContent, "\x1b[48;2;115;55;75m")).toBe("3");
		expect(charsWithBackground(added.highlightedContent, "\x1b[48;2;45;94;60m")).toBe("6");
	});

	it("pairs word diff lines by similarity when an edit also inserts a line", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-word-pair-"));
		const original =
			"const editCallRendered = render(edit.renderCall({ input: `$" +
			"{header}\\n2 2\\n+needle delta\\n` }, theme, {}));\n";
		writeFileSync(join(cwd, "sample.ts"), original);
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.ts" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];
		const inserted =
			'const editContext = { state: {}, invalidate: () => { throw new Error("edit render should not self-invalidate"); } };\n';
		const changed =
			"const editCallRendered = render(edit.renderCall({ input: `$" +
			"{header}\\n2 2\\n+needle delta\\n` }, theme, editContext));\n";

		const editResult = await tools
			.get("edit")
			.execute("edit", { input: `${header}\nreplace 1..1:\n+${inserted}+${changed}` }, undefined, undefined, {
				cwd,
			});
		const rows = editResult.details.highlightedDiffRows;
		const removed = rows.find((row: any) => row.kind === "remove");
		const addedInserted = rows.find((row: any) => row.kind === "add" && row.content.includes("editContext ="));
		const addedChanged = rows.find((row: any) => row.kind === "add" && row.content.includes("editCallRendered"));

		expect(removed.highlightedContent).not.toContain("\x1b[48;2;115;55;75mconst editCallRendered");
		expect(addedInserted.highlightedContent).not.toContain("\x1b[48;2;45;94;60m");
		expect(addedChanged.highlightedContent).toContain("\x1b[48;2;45;94;60m");
	});

	it("does not invent inline word diffs for unpaired multi-line rewrite blocks", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-complex-rewrite-"));
		writeFileSync(
			join(cwd, "sample.ts"),
			"const escaped = pattern.replace(/[.*+?^$" +
				'{}()|[\\]\\\\]/g, "\\\\$&");\nconst regex = new RegExp(escaped, "gi");\n',
		);
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.ts" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];
		const replacement = [
			"let regex: RegExp;",
			"try {",
			'\tregex = new RegExp(pattern, "gi");',
			"} catch {",
			"\tregex = new RegExp(pattern.replace(/[.*+?^$" + '{}()|[\\]\\\\]/g, "\\\\$&"), "gi");',
			"}",
			"",
		].join("\n");

		const editResult = await tools
			.get("edit")
			.execute("edit", { input: `${header}\nreplace 1..2:\n+${replacement}` }, undefined, undefined, { cwd });
		const rows = editResult.details.highlightedDiffRows;
		const changedRows = rows.filter((row: any) => row.kind === "remove" || row.kind === "add");

		expect(changedRows.every((row: any) => !row.highlightedContent.includes("\x1b[48;2;115;55;75m"))).toBe(true);
		expect(changedRows.every((row: any) => !row.highlightedContent.includes("\x1b[48;2;45;94;60m"))).toBe(true);
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
		expect(HASHLINE_GRAMMAR).toContain("replace_block_anchor");
		expect(REPLACE_GRAMMAR).toContain("*** Old");
	});
});
