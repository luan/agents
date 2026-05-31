import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fileopsExtension, { HASHLINE_GRAMMAR, PATCH_GRAMMAR, REPLACE_GRAMMAR } from "./index.ts";

const originalVariant = process.env.PI_FILEOPS_EDIT_VARIANT;
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

		await tool.execute("call", { input: `${header}\n1 1\n+hi\n+there\n2 2\n&2\n` }, undefined, undefined, { cwd });

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("hi\nthere\nworld\n");
	});

	it("hashline read emits snapshot headers and write strips copied display prefixes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-workflow-"));
		writeFileSync(join(cwd, "sample.txt"), "first\nsecond\nthird\n");
		const tools = registerEditTools("hashline");

		const readResult = await tools
			.get("read")
			.execute("read", { path: "sample.txt", offset: 1, limit: 2 }, undefined, undefined, { cwd });
		expect(readResult.content[0].text).toMatch(/^¶sample\.txt#[0-9A-F]{3}\n1:first\n2:second/);
		expect(readResult.content[0].text).toContain("[1 more line in file.");

		await tools
			.get("write")
			.execute("write", { path: "copy.txt", content: readResult.content[0].text }, undefined, undefined, { cwd });
		expect(readFileSync(join(cwd, "copy.txt"), "utf-8")).toBe("first\nsecond");
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

	it("hashline read supports path line selectors and sparse anchored edits", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-selector-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\nthree\nfour\n");
		const tools = registerEditTools("hashline");

		const readResult = await tools
			.get("read")
			.execute("read", { path: "sample.txt:2", ranges: ["3-3"] }, undefined, undefined, { cwd });
		expect(readResult.content[0].text).toMatch(/^¶sample\.txt#[0-9A-F]{3}\n2:two\n3:three/);
		const header = readResult.content[0].text.split("\n")[0];

		await tools
			.get("edit")
			.execute("call", { input: `${header}\n2 2\n+TWO\n3 3\n&3\n` }, undefined, undefined, { cwd });
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\nTWO\nthree\nfour\n");
	});

	it("hashline search output can drive sparse anchored edits", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-search-edit-"));
		writeFileSync(join(cwd, "sample.txt"), "alpha\nbeta\ngamma\n");
		const tools = registerEditTools("hashline");

		const searchResult = await tools
			.get("search")
			.execute("search", { pattern: "beta", path: "sample.txt", context: 1 }, undefined, undefined, { cwd });
		expect(searchResult.content[0].text).toMatch(/^¶sample\.txt#[0-9A-F]{3}\n 1:alpha\n\*2:beta\n 3:gamma/);
		const header = searchResult.content[0].text.split("\n")[0];

		await tools.get("edit").execute("call", { input: `${header}\n3 3\n+GAMMA\n` }, undefined, undefined, { cwd });

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
			tools.get("edit").execute("call", { input: `${header}\n2 2\n+TWO\n` }, undefined, undefined, { cwd }),
		).rejects.toThrow("file changed between read and edit");
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
		writeFileSync(join(cwd, "other.txt"), "alpha\n");
		const tools = registerEditTools("hashline");

		const searchResult = await tools
			.get("search")
			.execute("search", { pattern: "beta", path: "sample.txt" }, undefined, undefined, { cwd });
		expect(searchResult.content[0].text).toContain("¶sample.txt#");
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
		expect(readRendered.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).toContain("  1│alpha");

		const search = tools.get("search");
		const searchArgs = { pattern: "needle", path: "sample.txt" };
		const searchResult = await search.execute("search", searchArgs, undefined, undefined, { cwd });
		const searchRendered = render(
			search.renderResult(searchResult, { expanded: false, isPartial: false }, theme, { args: searchArgs }),
		);
		expect(searchRendered).toContain("✓ **Search:** needle 1 match · 1 file · in sample.txt");
		expect(searchRendered).toContain("*  2│");
		expect(searchRendered).toContain("needle");
		expect(searchRendered).toContain("beta");

		const find = tools.get("find");
		const findArgs = { paths: ["*.txt"] };
		const findResult = await find.execute("find", findArgs, undefined, undefined, { cwd });
		const findRendered = render(
			find.renderResult(findResult, { expanded: false, isPartial: false }, theme, { args: findArgs }),
		);
		expect(findRendered).toContain("✓ **Find:** *.txt 1 file · in .");
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
			edit.renderCall({ input: `${header}\n2 2\n+needle delta\n` }, theme, editContext),
		);
		expect(editCallRendered).toContain("✓ **Edit:** ≡ sample.txt:2");
		expect(editCallRendered).toContain("[toolPendingBg]");
		expect(editCallRendered).toStartWith("[toolPendingBg]✓");
		const runningState: Record<string, any> = {};
		const runningContext = { state: runningState, isPartial: true, invalidate() {} };
		const runningEarly = render(
			edit.renderCall({ input: `${header}\n2 2\n+needle delta\n` }, rgbTheme, runningContext),
		);
		if (runningState.elapsedTimer) clearTimeout(runningState.elapsedTimer);
		runningState.elapsedTimer = undefined;
		runningState.startedAtMs = Date.now() - 240;
		const runningLater = render(
			edit.renderCall({ input: `${header}\n2 2\n+needle delta\n` }, rgbTheme, runningContext),
		);
		if (runningState.elapsedTimer) clearTimeout(runningState.elapsedTimer);
		expect(stripAnsi(runningEarly)).toContain("**Editing** ≡ sample.txt:2");
		expect(stripAnsi(runningLater)).toContain("**Editing** ≡ sample.txt:2");
		expect(stripAnsi(runningLater)).toContain("⠹");
		expect(runningEarly).not.toBe(runningLater);

		const editResult = await edit.execute(
			"edit",
			{ input: `${header}\n2 2\n+needle delta\n` },
			undefined,
			undefined,
			{ cwd },
		);
		const editRendered = render(edit.renderResult(editResult, { expanded: true, isPartial: false }, theme, {}));
		expect(stripAnsi(editRendered)).toContain("delta");
		expect(editRendered).not.toContain("[toolSuccessBg]");

		const write = tools.get("write");
		const writeRendered = render(write.renderCall({ path: "out.txt", content: "one\ntwo" }, theme, {}));
		expect(writeRendered).toContain("✓ **Write:** ≡ out.txt · 2 lines");
		expect(writeRendered).toContain("1│one");
		expect(writeRendered).toContain("2│two");
		expect(writeRendered).not.toContain("[toolSuccessBg]");
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
			.execute("edit", { input: `${header}\n1 1\n+const value = 2;\n` }, undefined, undefined, { cwd });
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
		writeFileSync(join(cwd, "sample.ts"), "if (bestIndex >= 0 && bestScore >= 0.35) {\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.ts" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		const editResult = await tools
			.get("edit")
			.execute(
				"edit",
				{ input: `${header}\n1 1\n+if (bestIndex >= 0 && bestScore >= 0.65) {\n` },
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
			.execute("edit", { input: `${header}\n1 1\n+${inserted}+${changed}` }, undefined, undefined, { cwd });
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
			.execute("edit", { input: `${header}\n1 2\n+${replacement}` }, undefined, undefined, { cwd });
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
		expect(HASHLINE_GRAMMAR).toContain("body_range");
		expect(REPLACE_GRAMMAR).toContain("*** Old");
	});

	it("loads hashline grammar from the standalone OMP grammar file", () => {
		expect(HASHLINE_GRAMMAR).toBe(readFileSync(join(import.meta.dir, "hashline", "grammar.lark"), "utf-8"));
	});
});
