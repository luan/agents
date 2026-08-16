import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { resetCapabilitiesCache } from "@earendil-works/pi-tui";
import { recordNestedExplorationEnd, recordNestedExplorationStart } from "../shared/exploration-rendering.ts";
import {
	formatResourceUri,
	localResourceRoot,
	RESOURCE_SCHEMES,
	registerResourceProvider,
	resolvePathRef,
} from "../shared/resources.ts";
import { languageFromPath } from "./diff-render.ts";
import { deleteHashlineSnapshotStoreForSession, hashlineSnapshotStoreForSession } from "./hashline/anchors.ts";
import fileopsExtension, {
	APPLY_PATCH_GRAMMAR,
	HASHLINE_GRAMMAR,
	REPLACE_GRAMMAR,
	shortenDisplayPath,
	summarizeResource,
} from "./index.ts";

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

async function expectHashlineFailure(promise: Promise<any>, expected: string | RegExp): Promise<any> {
	const result = await promise;
	expect(result.details.status).toBe("failure");
	if (typeof expected === "string") expect(result.details.error).toContain(expected);
	else expect(result.details.error).toMatch(expected);
	return result;
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

	it("normalizes plain and file paths while preserving resource URIs", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-path-ref-"));
		const fileUri = pathToFileURL(join(cwd, "file.ts")).href;
		expect(resolvePathRef("src/file.ts", cwd)).toEqual({
			kind: "local",
			input: "src/file.ts",
			path: join(cwd, "src/file.ts"),
		});
		expect(resolvePathRef(fileUri, cwd)).toEqual({ kind: "local", input: fileUri, path: join(cwd, "file.ts") });
		const resource = resolvePathRef("local://scratch.txt", cwd);
		expect(resource.kind).toBe("resource");
		if (resource.kind === "resource") expect(resource.uri).toBe("local://scratch.txt");
	});
	it("keeps read labels visible for plain, valid, and malformed selectors", () => {
		const read = registerEditTools("hashline").get("read");
		const theme = {
			fg: (_role: string, text: string) => text,
			bold: (text: string) => text,
		};
		for (const path of ["sample.txt", "sample.txt:2-3", "sample.txt:2-0"]) {
			const rendered = read.renderCall({ path }, theme, { cwd: process.cwd() }).render(80).join("\n");
			expect(rendered).toContain(path);
			expect(rendered).not.toContain("[invalid]");
		}
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

	function readRenderFixture(title: string) {
		const summary = {
			icon: "",
			iconRole: "accent",
			label: "PR",
			title,
			subtitle: "main ← luan/topic",
			rows: [{ text: "State: OPEN" }],
		};
		return {
			theme: {
				fg: (_role: string, text: string) => text,
				bold: (text: string) => text,
				bg: (_role: string, text: string) => text,
			},
			result: {
				content: [{ type: "text", text: "State: OPEN\n\nDraft: false" }],
				details: { resourceSummary: summary },
			},
		};
	}

	it("leaves the read card to the call renderer, expanded or not", () => {
		const read = registerEditTools("hashline").get("read");
		const { theme, result } = readRenderFixture("#63489 remove obsolete adapter queue");
		recordNestedExplorationStart("read", "owned-read", { path: "pr://owner/repo/pull/63489" });
		recordNestedExplorationEnd("read", "owned-read");
		let invalidated = 0;
		const context = {
			toolCallId: "owned-read",
			cwd: process.cwd(),
			invalidate: () => {
				invalidated += 1;
			},
		};

		const collapsed = read.renderResult(result, { expanded: false }, theme, context).render(80).join("\n");
		const expanded = read.renderResult(result, { expanded: true }, theme, context).render(80).join("\n");

		expect(collapsed).not.toContain("#63489");
		expect(expanded).not.toContain("#63489");
		expect(expanded).toContain("State: OPEN");
		expect(invalidated).toBe(0);
	});
});

describe("fileops extension modes", () => {
	it("removes the session hashline store on shutdown", async () => {
		const sessionId = "hashline-shutdown-test";
		const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
		deleteHashlineSnapshotStoreForSession(sessionId);
		fileopsExtension({
			registerTool() {},
			registerCommand() {},
			on(event: string, handler: (event: unknown, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		} as any);
		const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => sessionId } };
		const first = hashlineSnapshotStoreForSession(sessionId);

		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);

		const next = hashlineSnapshotStoreForSession(sessionId);
		expect(next).not.toBe(first);
		deleteHashlineSnapshotStoreForSession(sessionId);
	});
	it("routes local resource URIs through session scratch space", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-resource-local-"));
		writeFileSync(join(cwd, "sample.txt"), "workspace\n");
		const tools = registerEditTools("hashline");
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

			await tools.get("edit").execute("edit", { input: `${header}\nPUT 2..2:\n+TWO\n` }, undefined, undefined, ctx);

			expect(content).toBe("one\nTWO\n");
		} finally {
			cleanup();
		}
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
			{ input: `${header}\nPUT 1..1:\n+hi\n+there\n` },
			undefined,
			undefined,
			{ cwd },
		);

		// `.txt` has no validator, so the edit is reported unguarded rather than passing. This rides `details`
		// only — `content` must stay clean, or every `.txt` edit would carry a warning.
		expect(result.details.results).toEqual([
			{ path: "sample.txt", header: expect.any(String), validation: "unchecked" },
		]);
		expect(result.content[0].text).not.toContain("unchecked");
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("hi\nthere\nworld\n");
	});

	it("supports apply_patch mode through the copied Rust engine", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-apply-patch-"));
		writeFileSync(join(cwd, "sample.txt"), "hello\nworld\n");
		const tool = registerEditTool("apply_patch");

		const result = await tool.execute(
			"call",
			{
				input: "*** Begin Patch\n*** Update File: sample.txt\n@@\n-hello\n+hi\n world\n*** End Patch\n",
			},
			undefined,
			undefined,
			{ cwd },
		);

		expect(result.details.status).toBe("success");
		expect(result.details.exact).toBe(true);
		expect(result.details.result.changedFiles).toEqual(["sample.txt"]);
		expect(result.details.results).toEqual([
			{
				path: "sample.txt",
				header: expect.stringMatching(/^\[sample\.txt#[0-9A-F]{4}\]$/),
				validation: "unchecked",
			},
		]);
		expect(result.details.diff).toContain("-hello");
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("hi\nworld\n");
	});

	it("hashline read emits snapshot headers and write strips copied display prefixes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-workflow-"));
		writeFileSync(join(cwd, "sample.txt"), "first\nsecond\nthird\n");
		const tools = registerEditTools("hashline");

		const readResult = await tools
			.get("read")
			.execute("read", { path: "sample.txt:1-2" }, undefined, undefined, { cwd });
		expect(readResult.content[0].text).toMatch(/^\[sample\.txt#[0-9A-F]{4}\]\n1:first\n2:second/);
		expect(readResult.content[0].text).toContain("[1 more line in file. Continue with `sample.txt:3-`.]");

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
			.execute("read", { path: "sample.txt:2,3" }, undefined, undefined, { cwd });
		expect(readResult.content[0].text).toMatch(/^\[sample\.txt#[0-9A-F]{4}\]\n2:two\n3:three/);
		const header = readResult.content[0].text.split("\n")[0];

		await tools.get("edit").execute("call", { input: `${header}\nPUT 2..2:\n+TWO\n` }, undefined, undefined, { cwd });
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\nTWO\nthree\nfour\n");
	});

	it("hashline edit rejects when a partial-read tag is used outside displayed lines", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-partial-authority-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\nthree\nfour\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools
			.get("read")
			.execute("read", { path: "sample.txt:2" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await expectHashlineFailure(
			tools.get("edit").execute("call", { input: `${header}\nPUT 4..4:\n+FOUR\n` }, undefined, undefined, { cwd }),
			/exact target range/,
		);
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\ntwo\nthree\nfour\n");
	});

	it("hashline edit rejects anchors that came only from synthetic read context", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-synthetic-authority-"));
		writeFileSync(join(cwd, "sample.ts"), "function x() {\n  return 1;\n}\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools
			.get("read")
			.execute("read", { path: "sample.ts:1" }, undefined, undefined, { cwd });
		const text = readResult.content[0].text;
		expect(text).toMatch(/1:function x\(\) \{/);
		expect(text).toMatch(/3:}/);
		const header = text.split("\n")[0];

		await expectHashlineFailure(
			tools
				.get("edit")
				.execute("call", { input: `${header}\nPUT >3:\n+const y = 2;\n` }, undefined, undefined, { cwd }),
			/synthetic context/,
		);
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

		await expectHashlineFailure(
			tools.get("edit").execute("call", { input: `${header}\nPUT 2..2:\n+TWO\n` }, undefined, undefined, sessionB),
			/matches current file/,
		);
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\ntwo\n");
	});
	it("does not mint an unknown live-matching snapshot on retry", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-unknown-retry-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\n");
		const tools = registerEditTools("hashline");
		const sourceCtx = { cwd, sessionManager: { getSessionId: () => `${cwd}:source` } };
		const foreignCtx = { cwd, sessionManager: { getSessionId: () => `${cwd}:foreign` } };
		const readResult = await tools
			.get("read")
			.execute("read", { path: "sample.txt" }, undefined, undefined, sourceCtx);
		const header = readResult.content[0].text.split("\n")[0];
		const edit = { input: `${header}\nPUT 2..2:\n+TWO\n` };

		for (let attempt = 0; attempt < 2; attempt++) {
			await expectHashlineFailure(
				tools.get("edit").execute("call", edit, undefined, undefined, foreignCtx),
				/matches current file, but this session has no snapshot record/,
			);
		}
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
			.execute("call", { input: `${header}\nPUT 2..2:\n+TWO\n` }, undefined, undefined, sessionCtx);
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\nTWO\n");
	});

	it("restores a missing hashline snapshot from the current session branch before editing", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-session-resume-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\n");
		const sourceTools = registerEditTools("hashline");
		const sourceCtx = { cwd, sessionManager: { getSessionId: () => `${cwd}:source` } };
		const readResult = await sourceTools
			.get("read")
			.execute("read", { path: "sample.txt" }, undefined, undefined, sourceCtx);
		const header = readResult.content[0].text.split("\n")[0];
		const resumedTools = new Map<string, any>();
		fileopsExtension({
			registerTool: (definition: any) => resumedTools.set(definition.name, definition),
			registerCommand: () => {},
			on: () => {},
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

		await resumedTools
			.get("edit")
			.execute("call", { input: `${header}\nPUT 2..2:\n+TWO\n` }, undefined, undefined, resumedCtx);
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
			.execute("call", { input: `${header}\nPUT <2:\n+before beta\nPUT >2:\n+after beta\n` }, undefined, undefined, {
				cwd,
			});

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
			.execute("call", { input: `${header}\nPUT 1..1:\n+const a = baz(1);\n` }, undefined, undefined, { cwd });
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

		await tools
			.get("edit")
			.execute("call", { input: `${header}\nPUT >2:\n+aaa\n+bbb\n+NEW\n+ccc\n+ddd\n` }, undefined, undefined, {
				cwd,
			});

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("aaa\nbbb\nNEW\nccc\nddd\n");
	});

	it("hashline after insertion preserves scope delimiters", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-scope-insert-"));
		writeFileSync(join(cwd, "sample.rs"), "#[cfg(test)]\nmod tests {\n    use super::*;\n}\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.rs" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await tools
			.get("edit")
			.execute("call", { input: `${header}\nPUT >2:\n+    #[test]\n+    fn smoke() {}\n` }, undefined, undefined, {
				cwd,
			});

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
			.execute("call", { input: `${header}\nPUT 3..3:\n+GAMMA\n` }, undefined, undefined, { cwd });

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

	it("keeps a single-file JSONL match row out of path parsing", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-search-jsonl-"));
		writeFileSync(join(cwd, "session.jsonl"), '{"timestamp":"2026-08-14T16:02:21.160Z","message":"target"}\n');
		const tools = registerEditTools("hashline");

		const searchResult = await tools
			.get("search")
			.execute("search", { pattern: "target", path: "session.jsonl" }, undefined, undefined, { cwd });

		expect(searchResult.details.highlightedSections.map((section: { path: string }) => section.path)).toEqual([
			"session.jsonl",
		]);
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

		await expectHashlineFailure(
			tools.get("edit").execute("call", { input: `${header}\nPUT 2..2:\n+TWO\n` }, undefined, undefined, { cwd }),
			"matches current file",
		);
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
			.execute("call", { input: `${header}\nPUT 2..2:\n+TWO\n` }, undefined, undefined, { cwd });

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

		await expectHashlineFailure(
			tools.get("edit").execute("call", { input: `${header}\nPUT 2..2:\n+TWO\n` }, undefined, undefined, { cwd }),
			"file changed between read and edit",
		);
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

		await expectHashlineFailure(
			tools
				.get("edit")
				.execute(
					"call",
					{ input: `${firstHeader}\nPUT 1..1:\n+A\n${secondHeader}\nPUT 99..99:\n+Z\n` },
					undefined,
					undefined,
					{ cwd },
				),
			"Line 99 does not exist",
		);
		expect(readFileSync(join(cwd, "first.txt"), "utf-8")).toBe("a\nb\n");
		expect(readFileSync(join(cwd, "second.txt"), "utf-8")).toBe("x\ny\n");
	});

	it("hashline edit preserves BOM and CRLF line endings", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-crlf-"));
		writeFileSync(join(cwd, "sample.txt"), "\uFEFFone\r\ntwo\r\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await tools.get("edit").execute("call", { input: `${header}\nPUT 2..2:\n+TWO\n` }, undefined, undefined, { cwd });

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("\uFEFFone\r\nTWO\r\n");
	});

	it("hashline edit refuses to create files and points at the write tool", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-no-create-"));
		const tools = registerEditTools("hashline");

		await expectHashlineFailure(
			tools.get("edit").execute("call", { input: "[created.txt#0A3B]\nPUT <1:\n+hello\n" }, undefined, undefined, {
				cwd,
			}),
			/File not found.*write tool/s,
		);
	});

	it("hashline edit requires the snapshot tag on every section", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-tag-required-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\n");
		const tools = registerEditTools("hashline");

		await expectHashlineFailure(
			tools.get("edit").execute("call", { input: "[sample.txt]\nPUT <1:\n+zero\n" }, undefined, undefined, {
				cwd,
			}),
			"Missing hashline snapshot tag",
		);
		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\ntwo\n");
	});

	it("hashline edit treats an empty PUT hunk as a range delete", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-empty-replace-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\nthree\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await tools.get("edit").execute("call", { input: `${header}\nPUT 2..3:\n` }, undefined, undefined, { cwd });

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\n");
	});

	it("hashline edit supports CUT range hunks", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-explicit-delete-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\nthree\nfour\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await tools.get("edit").execute("call", { input: `${header}\nCUT 2..3\n` }, undefined, undefined, { cwd });

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
			.execute("call", { input: `${header}\nPUT 2..3:\n+\tsetup2();\n+\trun2();\n+});\n` }, undefined, undefined, {
				cwd,
			});

		expect(readFileSync(join(cwd, "sample.ts"), "utf-8")).toBe(
			"it('a', () => {\n\tsetup2();\n\trun2();\n});\nafter();\n",
		);
		expect(result.content[0].text).toContain("Warnings:");
		expect(result.content[0].text).toContain(
			"dropped 1 duplicated trailing payload line(s) already present below the range",
		);
	});

	it("hashline edit resolves PUT block spans through tree-sitter and echoes them", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-block-"));
		writeFileSync(
			join(cwd, "sample.ts"),
			'function greet(name: string) {\n\treturn "hi " + name;\n}\nconst x = 1;\n',
		);
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.ts" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		await tools.get("edit").execute(
			"call",
			{
				input: `${header}\nPUT 1*:\n+function greet(name: string) {\n+\treturn "hello " + name;\n+}\n`,
			},
			undefined,
			undefined,
			{ cwd },
		);

		expect(readFileSync(join(cwd, "sample.ts"), "utf-8")).toBe(
			'function greet(name: string) {\n\treturn "hello " + name;\n}\nconst x = 1;\n',
		);
	});

	it("hashline edit reports a no-op apply with the re-read diagnostic", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-noop-"));
		writeFileSync(join(cwd, "sample.txt"), "one\ntwo\n");
		const tools = registerEditTools("hashline");
		const readResult = await tools.get("read").execute("read", { path: "sample.txt" }, undefined, undefined, { cwd });
		const header = readResult.content[0].text.split("\n")[0];

		const result = await tools
			.get("edit")
			.execute("call", { input: `${header}\nPUT 2..2:\n+two\n` }, undefined, undefined, { cwd });

		expect(readFileSync(join(cwd, "sample.txt"), "utf-8")).toBe("one\ntwo\n");
		expect(result.content[0].text).toContain("produced no change");
		expect(result.content[0].text).toContain("re-read the file");
	});

	it("bounds a large unparseable whole-file read instead of refusing it", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-large-read-"));
		writeFileSync(join(cwd, "large.log"), `${"x".repeat(60_000)}\n`);
		const tools = registerEditTools("hashline");

		const result = await tools.get("read").execute("read", { path: "large.log" }, undefined, undefined, { cwd });
		const text = result.content[0].text;

		expect(result.details.outputBounded).toBe(true);
		expect(text).toContain("output bounded");
		expect(text.length).toBeLessThan(60_000);
	});

	it("returns a notice instead of the bytes of a binary file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-binary-read-"));
		writeFileSync(join(cwd, "blob.bin"), Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03]));
		const tools = registerEditTools("hashline");

		const result = await tools.get("read").execute("read", { path: "blob.bin" }, undefined, undefined, { cwd });

		expect(result.details.readKind).toBe("binary");
		expect(result.content[0].text).toContain("binary file");
		expect(result.content[0].text).toContain("blob.bin:raw");
	});

	it("indexes unresolved merge conflicts with the :conflicts selector", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-conflicts-"));
		writeFileSync(
			join(cwd, "merged.txt"),
			["alpha", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feature", "omega", ""].join("\n"),
		);
		const tools = registerEditTools("hashline");

		const result = await tools
			.get("read")
			.execute("read", { path: "merged.txt:conflicts" }, undefined, undefined, { cwd });
		const text = result.content[0].text;

		expect(result.details.conflictCount).toBe(1);
		expect(text).toMatch(/^\[merged\.txt#[0-9A-F]{4}\]/);
		expect(text).toContain("#1 2-6 · ours 3-3 · theirs 5-5");
		expect(text).toContain("2:<<<<<<< HEAD");
		expect(text).not.toContain("1:alpha");
	});

	it("allows bounded reads from large files for edit targeting", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-hashline-bounded-large-read-"));
		writeFileSync(join(cwd, "large.log"), `${"x".repeat(60_000)}\nneedle\n`);
		const tools = registerEditTools("hashline");

		const result = await tools.get("read").execute("read", { path: "large.log:2" }, undefined, undefined, { cwd });

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

	// Every findToolSchema field is Optional, so each of these was a schema-valid call that threw
	// "Cannot read properties of undefined (reading 'includes')" from pi-coding-agent find.js:189.
	// A routing probe hit it on the opening move of 12 of 24 trials and no test covered any shape.
	it.each([
		["path only", { path: "sub" }],
		["no arguments at all", {}],
		["path with gitignore", { path: "sub", gitignore: true }],
		["path with hidden", { path: "sub", hidden: true }],
	])("lists everything under the path when called with %s", async (_label, params) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-find-pattern-default-"));
		mkdirSync(join(cwd, "sub", "nested"), { recursive: true });
		writeFileSync(join(cwd, "sub", "top.txt"), "");
		writeFileSync(join(cwd, "sub", "nested", "deep.txt"), "");
		const tools = registerEditTools("hashline");

		const result = await tools.get("find").execute("find", params, undefined, undefined, { cwd });
		const text = result.content[0].text;

		expect(text).toContain("top.txt");
		expect(text).toContain("deep.txt");
	});

	// Each of these returned a successful result that did not do what was asked. `search({query})` was the worst: it
	// reported "No matches found" for a file it never searched, and 4 read range shapes returned the whole file.
	it.each([
		["query", { query: "beta" }],
		["regex", { regex: "beta" }],
		["q", { q: "beta" }],
	])("finds the match when the pattern arrives as %s", async (_label, args) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-search-alias-"));
		writeFileSync(join(cwd, "sample.txt"), "alpha\nbeta\n");
		const tools = registerEditTools("hashline");
		const search = tools.get("search");

		const result = await search.execute(
			"s",
			search.prepareArguments({ ...args, path: "sample.txt" }),
			undefined,
			undefined,
			{ cwd },
		);

		expect(result.content[0].text).toContain("2:beta");
	});

	it("uses search glob to restrict local matches", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-search-glob-"));
		writeFileSync(join(cwd, "a.ts"), "needle\n");
		writeFileSync(join(cwd, "b.txt"), "needle\n");
		const search = registerEditTools("hashline").get("search");
		expect(search.parameters.properties.glob).toBeDefined();
		const result = await search.execute("s", { pattern: "needle", glob: "*.ts" }, undefined, undefined, { cwd });
		expect(result.content[0].text).toContain("a.ts");
		expect(result.content[0].text).not.toContain("b.txt");
	});

	// `glob` is an alias for `pattern` (prepareFindArguments), so a probe that skips prepareArguments sees `pattern`
	// default to `**` and every file returned — which looks exactly like a dropped filter. Locking both halves down.
	it("honours glob as a pattern alias and rejects an unusable glob", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-find-glob-"));
		writeFileSync(join(cwd, "a.swift"), "x\n");
		writeFileSync(join(cwd, "n.txt"), "x\n");
		const tools = registerEditTools("hashline");
		const find = tools.get("find");

		const run = (args: Record<string, unknown>) =>
			find.execute("f", find.prepareArguments(args), undefined, undefined, { cwd });

		const filtered = await run({ glob: "*.swift" });
		expect(filtered.content[0].text).toContain("a.swift");
		expect(filtered.content[0].text).not.toContain("n.txt");

		await expect(run({ glob: "[" })).rejects.toThrow(/could not run that glob/);
		await expect(run({ glob: "[" })).rejects.toThrow(/error parsing glob/);
	});

	// rg exits 2 on a parse error with empty stdout, which used to fall into the no-match branch and report a false
	// negative as fact. `rg 'unique\(by'` finds real matches, so "No matches found" was wrong, not just unhelpful.
	it("retries an invalid regex literally unless literal is explicitly false", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-search-badregex-"));
		writeFileSync(join(cwd, "a.swift"), "func unique(by x: Int) {}\n");
		const search = registerEditTools("hashline").get("search");
		const run = (args: Record<string, unknown>) =>
			search.execute("s", search.prepareArguments({ path: ".", ...args }), undefined, undefined, { cwd });

		const retried = await run({ pattern: "unique(by" });
		expect(retried.content[0].text).toContain("Pattern treated as literal text because it did not parse as a regex.");
		expect(retried.content[0].text).toContain("unique(by");
		await expect(run({ pattern: "unique(by", literal: false })).rejects.toThrow(/regex parse error/);
		expect((await run({ pattern: "definitelyabsent" })).content[0].text).toContain("No matches found");
		expect((await run({ pattern: "unique(by", literal: true })).content[0].text).not.toContain(
			"Pattern treated as literal text",
		);
	});

	it.each([
		["missing file", "missing"],
		["glob-shaped path", "Frameworks/ARCClients/Sources/Live*Client"],
	])("reports a missing search path for %s", async (_label, path) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-search-missing-root-"));
		const search = registerEditTools("hashline").get("search");

		await expect(search.execute("s", { pattern: "alpha", path }, undefined, undefined, { cwd })).rejects.toThrow(
			/search path.*not found/i,
		);
	});
	it.each([
		["read", "4281-const x", {}],
		["read", "4281: const x", {}],
		["search", "4281-const x", { pattern: "x" }],
		["search", "4281: const x", { pattern: "x" }],
	])("rejects copied result rows passed as %s paths", (toolName, path, args) => {
		const tool = registerEditTools("hashline").get(toolName);

		expect(() => tool.prepareArguments({ ...args, path })).toThrow(/N:TEXT and N-TEXT are result rows, not paths/);
	});

	it("honours raw as a read compatibility argument", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-read-raw-"));
		writeFileSync(join(cwd, "sample.txt"), "alpha\nbeta\n");
		const read = registerEditTools("hashline").get("read");
		const result = await read.execute("r", { path: "sample.txt", raw: true }, undefined, undefined, { cwd });
		expect(result.content[0].text).toContain("alpha\nbeta");
		expect(result.content[0].text).not.toContain("1:alpha");
	});
	it.each([
		["read", { path: "sample.txt", cmd: "cat" }],
		["search", { pattern: "alpha", context_guard: 1 }],
		["find", { paths: ["."], timeout: 1 }],
		["edit", { patch: "PUT 1..1:\n+x\n" }],
	])("rejects unsupported %s arguments instead of ignoring them", async (toolName, args) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-fileops-unsupported-"));
		const tool = registerEditTools("hashline").get(toolName);
		await expect(tool.execute("call", args, undefined, undefined, { cwd })).rejects.toThrow(/does not support/);
	});

	it("rejects arguments that resource providers or path precedence would ignore", async () => {
		const tools = registerEditTools("hashline");
		const cwd = mkdtempSync(join(tmpdir(), "pi-fileops-ignored-"));
		const search = tools.get("search");
		const find = tools.get("find");

		await expect(
			search.execute("search", { pattern: "needle", path: "skill://demo", glob: "*.ts" }, undefined, undefined, {
				cwd,
			}),
		).rejects.toThrow(/glob.*local paths/);
		await expect(
			search.execute("search", { pattern: "needle", path: "skill://demo", ranges: ["1-2"] }, undefined, undefined, {
				cwd,
			}),
		).rejects.toThrow(/ranges.*local paths/);
		await expect(
			find.execute("find", { paths: ["skill://demo"], hidden: true }, undefined, undefined, { cwd }),
		).rejects.toThrow(/hidden.*local paths/);
		await expect(
			find.execute("find", { paths: ["skill://demo"], gitignore: true }, undefined, undefined, { cwd }),
		).rejects.toThrow(/gitignore.*local paths/);
		await expect(
			find.execute("find", { paths: ["*.ts"], glob: "*.txt" }, undefined, undefined, { cwd }),
		).rejects.toThrow(/cannot combine paths/);
	});

	it.each([
		["no pattern", {}],
		["an empty pattern", { pattern: "" }],
	])("refuses to report a result for %s rather than saying no matches", async (_label, args) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-search-empty-"));
		writeFileSync(join(cwd, "sample.txt"), "alpha\nbeta\n");
		const tools = registerEditTools("hashline");
		const search = tools.get("search");

		await expect(
			search.execute("s", search.prepareArguments({ ...args, path: "sample.txt" }), undefined, undefined, { cwd }),
		).rejects.toThrow(/non-empty `pattern`/);
	});

	// One short sentence that hands back the corrected selector. Single-grammar: the tool accepts selectors only, and
	// our own truncation notice already emits the selector form, so notice and tool agree.
	it.each([
		["offset and limit", { offset: 2, limit: 2 }],
		["start_line and end_line", { start_line: 2, end_line: 3 }],
		["range", { range: "2-3" }],
		["lines", { lines: "2-3" }],
	])("refuses a read windowed by %s in one short sentence naming the selector", async (_label, args) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-read-range-"));
		writeFileSync(join(cwd, "sample.txt"), "alpha\nbeta\ngamma\n");
		const tools = registerEditTools("hashline");
		const read = tools.get("read");

		const failure = await read
			.execute("r", read.prepareArguments({ path: "sample.txt", ...args }), undefined, undefined, { cwd })
			.catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toMatch(/carries the range on `path`/);
		expect(message).toContain("sample.txt:120-180");
		expect(message.split(/\s+/).length).toBeLessThan(25);
	});

	it("filters by glob when the key arrives as glob or name rather than listing everything", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-find-alias-"));
		for (const name of ["a.txt", "c.rs"]) writeFileSync(join(cwd, name), "x\n");
		const tools = registerEditTools("hashline");
		const find = tools.get("find");

		for (const args of [{ glob: "*.txt" }, { name: "*.txt" }]) {
			const result = await find.execute("f", find.prepareArguments(args), undefined, undefined, { cwd });
			expect(result.content[0].text).toBe("a.txt");
		}
	});

	it("reads through the file_path alias instead of crashing on the selector split", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-read-alias-"));
		writeFileSync(join(cwd, "sample.txt"), "alpha\n");
		const tools = registerEditTools("hashline");
		const read = tools.get("read");

		const result = await read.execute("r", read.prepareArguments({ file_path: "sample.txt" }), undefined, undefined, {
			cwd,
		});

		expect(result.content[0].text).toContain("1:alpha");
	});

	it.each([
		["sample.txt#320-430", "sample.txt:320-430"],
		["sample.txt#L1-L240", "sample.txt:1-240"],
		["sample.txt#L42", "sample.txt:42"],
	])("returns the canonical selector for a range written after #", async (path, corrected) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-read-hash-range-"));
		writeFileSync(join(cwd, "sample.txt"), "alpha\nbeta\ngamma\n");
		const read = registerEditTools("hashline").get("read");

		await expect(read.execute("r", { path }, undefined, undefined, { cwd })).rejects.toThrow(
			`read path uses \`#\` for a line range; rerun with \`${corrected}\`.`,
		);
	});

	it("does not classify missing files or hashline tags as range selectors", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-read-missing-"));
		const read = registerEditTools("hashline").get("read");

		await expect(read.execute("r", { path: "missing.txt" }, undefined, undefined, { cwd })).rejects.toThrow(
			/ENOENT|no such file/i,
		);
		await expect(read.execute("r", { path: "missing.txt#A1B2" }, undefined, undefined, { cwd })).rejects.toThrow(
			/ENOENT|no such file/i,
		);
	});
	it("hands back an unescaped path when a backslash-escaped path is missing", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-read-escaped-path-"));
		const path = join(cwd, "sample.txt");
		writeFileSync(path, "alpha\n");
		const escaped = path.replaceAll("/", "\\/");
		const read = registerEditTools("hashline").get("read");

		const failure = await read
			.execute("r", { path: escaped }, undefined, undefined, { cwd })
			.catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("Path carries backslash escapes");
		expect((failure as Error).message).toContain(path);
	});

	it("names find when read receives a directory", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-read-directory-"));
		const directory = join(cwd, "folder");
		mkdirSync(directory);
		const read = registerEditTools("hashline").get("read");

		await expect(read.execute("r", { path: directory }, undefined, undefined, { cwd })).rejects.toThrow(
			/Path is a directory.*find/,
		);
	});

	it("keeps dated filenames whole while parsing genuine trailing selectors", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-read-dated-file-"));
		const sessionName = "2026-08-13T21-59-33-123Z_019ffd25-ad00-7f6b-8c3a-b9c11a72fa86.jsonl";
		writeFileSync(join(cwd, sessionName), "session\n");
		writeFileSync(join(cwd, "report-2024-01-02.md"), "report\n");
		writeFileSync(join(cwd, "index.ts"), Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n"));
		const read = registerEditTools("hashline").get("read");

		expect((await read.execute("r", { path: sessionName }, undefined, undefined, { cwd })).content[0].text).toContain(
			"1:session",
		);
		expect(
			(await read.execute("r", { path: "report-2024-01-02.md" }, undefined, undefined, { cwd })).content[0].text,
		).toContain("1:report");
		const ranged = await read.execute("r", { path: "index.ts:120-180" }, undefined, undefined, { cwd });
		expect(ranged.details.ranges).toEqual([{ start: 120, end: 180 }]);
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
		expect(tools.get("find").parameters.properties.limit).toBeDefined();
		// `limit` caps each page while the tool window remains the hard ceiling.
		const findResult = await tools
			.get("find")
			.execute("find", { paths: ["*.txt"], limit: 1 }, undefined, undefined, { cwd });
		expect(findResult.content[0].text).toContain("other.txt");
		expect(findResult.content[0].text).toContain("skip=1");
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

	it("supports PUT mode snake-case and all true", async () => {
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

	it("has a dedicated grammar for each edit mode", () => {
		expect(APPLY_PATCH_GRAMMAR).toContain("start:");
		expect(HASHLINE_GRAMMAR).toContain("mv_hunk");
		expect(REPLACE_GRAMMAR).toContain("*** Old");
	});
});

describe("github resource cards", () => {
	// `gh issue view 1 --repo thebrowsercompany/arc` returns the pull request: one numbering space, `state` of MERGED.
	const mergedPullRequest = {
		uri: "issue://thebrowsercompany/arc/1",
		name: "1",
		title: "[ADK] Define the first version of Browser APIs",
		kind: "issue",
		mediaType: "text/markdown",
		metadata: {
			number: 1,
			title: "[ADK] Define the first version of Browser APIs",
			state: "MERGED",
			stateReason: "",
			url: "https://github.com/thebrowsercompany/arc/pull/1",
			author: { is_bot: true, login: "app/" },
			repository: "thebrowsercompany/arc",
		},
	};

	// `purpleStatus` paints the label, so the badge is compared with the colour removed.
	const badge = (summary: { statusLabel?: string } | undefined) =>
		summary?.statusLabel?.replace(/\x1b\[[0-9;]*m/g, "");

	it("never badges a merged resource as open", () => {
		const summary = summarizeResource(mergedPullRequest as never, "State: MERGED");

		expect(badge(summary)).toBe("merged");
		expect(badge(summary)).not.toBe("open");
	});

	it("labels a pull request read through issue:// as a PR", () => {
		const summary = summarizeResource(mergedPullRequest as never, "State: MERGED");

		expect(summary?.label).toBe("PR");
	});

	it("renders an app author without a bare trailing slash", () => {
		const summary = summarizeResource(mergedPullRequest as never, "State: MERGED");

		expect(summary?.author?.text).toBe("GitHub App");
		expect(summary?.author?.url).toBeUndefined();
		expect(summary?.author?.avatarUrl).toBeUndefined();
	});

	it("still badges an open issue as open", () => {
		const summary = summarizeResource(
			{
				uri: "issue://thebrowsercompany/arc/2",
				name: "2",
				title: "A real issue",
				kind: "issue",
				metadata: { number: 2, state: "OPEN", url: "https://github.com/thebrowsercompany/arc/issues/2" },
			} as never,
			"State: OPEN",
		);

		expect(badge(summary)).toBe("open");
		expect(summary?.label).toBe("issue");
	});
});
