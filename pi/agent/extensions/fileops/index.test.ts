import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { resetCapabilitiesCache } from "@earendil-works/pi-tui";
import {
	formatResourceUri,
	localResourceRoot,
	RESOURCE_SCHEMES,
	registerResourceProvider,
} from "../shared/resources.ts";
import { languageFromPath } from "./diff-render.ts";
import fileopsExtension, { HASHLINE_GRAMMAR, PATCH_GRAMMAR, REPLACE_GRAMMAR, shortenDisplayPath } from "./index.ts";

const originalVariant = process.env.PI_FILEOPS_EDIT_VARIANT;
const originalAutoDropPureInsertDuplicates = process.env.PI_FILEOPS_HASHLINE_AUTO_DROP_PURE_INSERT_DUPLICATES;

afterEach(() => {
	resetCapabilitiesCache();
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

describe("resource display paths", () => {
	it("keeps local paths human-readable and preserves non-local URIs", () => {
		const cwd = join(homedir(), "src", "agents");

		expect(shortenDisplayPath("crates/blabla/a.rs", cwd)).toBe("crates/blabla/a.rs");
		expect(shortenDisplayPath(join(homedir(), "tmp", "blabla"), cwd)).toBe("~/tmp/blabla");
		expect(shortenDisplayPath("/tmp/blabla", cwd)).toBe("/tmp/blabla");
		expect(shortenDisplayPath("local://scratch/data.json", cwd)).toBe("local://scratch/data.json");
		expect(shortenDisplayPath("pr://luan/agents/23", cwd)).toBe("pr://luan/agents/23");
	});
	it("reuses read call components across redraws", () => {
		const tools = registerEditTools("hashline");
		const read = tools.get("read");
		const theme = {
			fg: (_role: string, text: string) => text,
			bold: (text: string) => text,
		};
		const first = read.renderCall({ path: "pr://owner/repo/1" }, theme, { cwd: process.cwd() });
		const second = read.renderCall({ path: "pr://owner/repo/1" }, theme, {
			cwd: process.cwd(),
			lastComponent: first,
		});
		expect(second).toBe(first);
	});
});

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

	it("routes local resource URIs through session scratch space", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-resource-local-"));
		writeFileSync(join(cwd, "sample.txt"), "workspace\n");
		const tools = registerEditTools("apply_patch");
		const sessionId = `resource-local-${Date.now()}`;
		const ctx = { cwd, sessionManager: { getSessionId: () => sessionId } };

		await tools
			.get("write")
			.execute("write", { path: "local://sample.txt", content: "alpha\nbeta\n" }, undefined, undefined, ctx);

		const read = await tools.get("read").execute("read", { path: "local://sample.txt" }, undefined, undefined, ctx);
		expect(read.content[0].text).toContain("1:alpha\n2:beta");
		const listing = await tools.get("read").execute("read", { path: "local://" }, undefined, undefined, ctx);
		expect(listing.content[0].text).toContain("local://sample.txt");

		const search = await tools
			.get("search")
			.execute("search", { pattern: "beta", path: "local://sample.txt" }, undefined, undefined, ctx);
		expect(search.content[0].text).toContain("2:beta");

		const found = await tools.get("find").execute("find", { paths: ["local://"] }, undefined, undefined, ctx);
		expect(found.content[0].text).toContain("local://sample.txt");

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("workspace\n");
		expect(readFileSync(join(localResourceRoot({ sessionId }), "sample.txt"), "utf-8")).toBe("alpha\nbeta\n");
	});
	it("routes every supported resource scheme through find, search, read, write, and edit", async () => {
		process.env.PI_FILEOPS_EDIT_VARIANT = "replace";
		const tools = registerEditTools("replace");
		const values = new Map<string, string>();
		const cleanups = RESOURCE_SCHEMES.map((scheme) =>
			registerResourceProvider(scheme, {
				async read(ref) {
					const uri = formatResourceUri(ref);
					return { resource: { uri, name: "item.txt" }, content: values.get(uri) ?? "" };
				},
				async search(request) {
					const uri = formatResourceUri(request.scope!);
					return [{ uri, name: "item.txt", snippet: request.query, score: 1 }];
				},
				async find(ref) {
					const uri = formatResourceUri(ref);
					return [{ uri, name: "item.txt" }];
				},
				async write(ref, request) {
					const uri = formatResourceUri(ref);
					values.set(uri, request.content);
					return { resource: { uri, name: "item.txt" }, bytes: Buffer.byteLength(request.content) };
				},
			}),
		);
		const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "resource-matrix" } };
		try {
			for (const scheme of RESOURCE_SCHEMES) {
				const uri = `${scheme}://demo/item.txt`;
				values.set(uri, `${scheme}\nneedle\n`);

				await tools.get("read").execute("read", { path: uri }, undefined, undefined, ctx);
				await tools.get("search").execute("search", { pattern: "needle", path: uri }, undefined, undefined, ctx);
				await tools.get("find").execute("find", { paths: [uri] }, undefined, undefined, ctx);
				await tools
					.get("write")
					.execute("write", { path: uri, content: `${scheme}\nupdated\n` }, undefined, undefined, ctx);
				await tools
					.get("edit")
					.execute(
						"edit",
						{ path: uri, edits: [{ old_text: "updated", new_text: "edited" }] },
						undefined,
						undefined,
						ctx,
					);

				expect(values.get(uri)).toBe(`${scheme}\nedited\n`);
			}
		} finally {
			for (const cleanup of cleanups.reverse()) cleanup();
		}
	});
	it("hashline mode anchors and edits writable resource URIs", async () => {
		process.env.PI_FILEOPS_EDIT_VARIANT = "hashline";
		const tools = registerEditTools("hashline");
		const uri = "vault://demo.md";
		let content = "one\ntwo\n";
		const cleanup = registerResourceProvider("vault", {
			async read(ref) {
				return { resource: { uri: formatResourceUri(ref), name: "demo.md" }, content };
			},
			async search() {
				return [];
			},
			async find(ref) {
				return [{ uri: formatResourceUri(ref), name: "demo.md" }];
			},
			async write(ref, request) {
				content = request.content;
				return {
					resource: { uri: formatResourceUri(ref), name: "demo.md" },
					bytes: Buffer.byteLength(content),
				};
			},
		});
		const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "resource-hashline" } };
		try {
			const read = await tools.get("read").execute("read", { path: uri }, undefined, undefined, ctx);
			const header = read.content[0].text.split("\n")[0];

			await tools
				.get("edit")
				.execute("edit", { input: `${header}\nreplace 2..2:\n+TWO\n` }, undefined, undefined, ctx);

			expect(content).toBe("one\nTWO\n");
		} finally {
			cleanup();
		}
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

		const result = await tool.execute(
			"call",
			{ input: `${header}\nreplace 1..1:\n+hi\n+there\n` },
			undefined,
			undefined,
			{ cwd },
		);

		expect(result.details.results).toEqual([{ path: "sample.txt", header: expect.any(String) }]);
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
		expect(readResult.details?.previewImage?.mimeType).toBe("image/png");
		expect(readResult.details?.previewImage?.sourcePath).toEndWith(".png");
		expect(readResult.content.some((content: any) => content.type === "image")).toBe(false);
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

	it("restores hashline snapshots from a resumed session branch", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-session-resume-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\n");
		const sourceTools = registerEditTools("hashline");
		const sourceCtx = { cwd, sessionManager: { getSessionId: () => `${cwd}:source` } };
		const readResult = await sourceTools
			.get("read")
			.execute("read", { path: "sample.txt" }, undefined, undefined, sourceCtx);
		const header = readResult.content[0].text.split("\n")[0];
		const resumedTools = new Map<string, any>();
		let sessionStart: ((event: unknown, ctx: any) => Promise<void>) | undefined;
		fileopsExtension({
			registerTool: (definition: any) => resumedTools.set(definition.name, definition),
			registerCommand: () => {},
			on: (event: string, handler: any) => {
				if (event === "session_start") sessionStart = handler;
			},
		} as any);
		const resumedCtx = {
			cwd,
			sessionManager: {
				getSessionId: () => `${cwd}:resumed`,
				getBranch: () => [
					{
						type: "message",
						message: { role: "toolResult", content: [{ type: "text", text: readResult.content[0].text }] },
					},
				],
			},
		};

		await sessionStart?.({}, resumedCtx);
		await resumedTools
			.get("edit")
			.execute("call", { input: `${header}\nreplace 2..2:\n+TWO\n` }, undefined, undefined, resumedCtx);
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

	it("applies search limits after filtering selected ranges", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-search-range-limit-"));
		writeFileSync(join(cwd, "sample.txt"), `${"needle\n".repeat(10)}target needle\n`);
		const tools = registerEditTools("hashline");

		const searchResult = await tools
			.get("search")
			.execute("search", { pattern: "needle", path: "sample.txt", ranges: ["11"], limit: 1 }, undefined, undefined, {
				cwd,
			});

		expect(searchResult.content[0].text).toContain("*11:target needle");
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
		expect(text).toContain("bounded reads and search only the needed ranges.");
		expect(text.length).toBeLessThan(2_000);
		expect(text).not.toContain("x".repeat(1_000));
	});

	it("summarizes large full-file code reads", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-summary-read-"));
		const body = Array.from({ length: 240 }, (_, index) => `\tconst value${index} = ${index};`).join("\n");
		writeFileSync(join(cwd, "large.ts"), `export function large() {\n${body}\n}\n`);
		const read = registerEditTools("hashline").get("read");

		const result = await read.execute("read", { path: "large.ts" }, undefined, undefined, { cwd });

		expect(result.details.summary.elidedLines).toBeGreaterThan(200);
		expect(result.content[0].text).toContain("lines elided; re-read needed ranges");
		expect(result.content[0].text).not.toContain("value120");
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

	it("caps search output and asks for narrower scope", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-search-cap-"));
		writeFileSync(
			join(cwd, "large.txt"),
			Array.from({ length: 205 }, (_, index) => `needle ${index + 1}`).join("\n"),
		);
		const tools = registerEditTools("hashline");

		const result = await tools.get("search").execute("search", { pattern: "needle" }, undefined, undefined, { cwd });
		const text = result.content[0].text;

		expect((text.match(/\*?\d+:needle/g) ?? []).length).toBe(200);
		expect(text).toContain("Match budget reached");
		expect(text).toContain("Narrow the pattern, path, or glob to see the rest.");
	});

	it("caps find output and reports when additional files were omitted", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-find-cap-"));
		for (let index = 0; index < 205; index++)
			writeFileSync(join(cwd, `file-${String(index).padStart(3, "0")}.txt`), "");
		const tools = registerEditTools("hashline");

		const result = await tools.get("find").execute("find", { paths: ["*.txt"] }, undefined, undefined, { cwd });
		const text = result.content[0].text;

		// The file window is policy now, not a model-supplied limit, and the
		// notice names the next call instead of just reporting the cut.
		expect(text.split("\n").filter((line: string) => line.endsWith(".txt"))).toHaveLength(20);
		expect(text).toContain("of 205");
		expect(text).toContain("skip=20");
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
		// `limit` is no longer part of the schema; a stale caller passing it is
		// ignored rather than rejected, so the full window comes back.
		const findResult = await tools
			.get("find")
			.execute("find", { paths: ["*.txt"], limit: 1 }, undefined, undefined, { cwd });
		expect(findResult.content[0].text).toBe("other.txt\nsample.txt");
		const absoluteFindResult = await tools
			.get("find")
			.execute("find", { paths: [join(cwd, "*.txt")], limit: 10 }, undefined, undefined, { cwd });
		expect(absoluteFindResult.content[0].text).toBe("other.txt\nsample.txt");
		const missingRootResult = await tools
			.get("find")
			.execute("find", { paths: ["missing-root/**"], limit: 10 }, undefined, undefined, { cwd });
		expect(missingRootResult.content[0].text).toBe("No files found matching pattern");
	});

	it("uses Luau grammar for Luau file suffixes", async () => {
		expect(languageFromPath("init.luau")).toBe("luau");
		expect(languageFromPath("src/Player.server.lua")).toBe("luau");
		expect(languageFromPath("src/Player.client.lua")).toBe("luau");
		expect(languageFromPath("plain.lua")).toBe("lua");
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

	it("fuzzy matches replace-mode edits", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-replace-fuzzy-"));
		writeFileSync(join(cwd, "sample.ts"), "function value() {\n  return current;\n}\n");
		const tool = registerEditTool("replace");

		await tool.execute(
			"call",
			{
				input: "*** File: sample.ts\n*** Old\n|function value() {\n| return   current;\n|}\n*** New\n|function value() {\n|  return next;\n|}\n",
			},
			undefined,
			undefined,
			{ cwd },
		);

		expect(readFileSync(join(cwd, "sample.ts"), "utf-8")).toContain("return next;");
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
