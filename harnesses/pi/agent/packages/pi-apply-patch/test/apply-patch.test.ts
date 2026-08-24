import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getCodeModeToolAdapterRegistry } from "pi-code-mode/sdk";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE, icon } from "pi-libtui";
import { parseUnifiedDiff } from "pi-libtui/diff";
import { resolveApplyPatchBinary } from "../src/binary.ts";
import { executePatchWithRust } from "../src/executor.ts";
import applyPatchExtension from "../src/extension.ts";
import { createApplyPatchTool } from "../src/tools/apply-patch/definition.ts";
import { patchPreviewModel, renderApplyPatchResult } from "../src/tools/apply-patch/presentation.ts";
import { createApplyPatchRunningResult, createApplyPatchSuccessResult } from "../src/tools/apply-patch/result.ts";
import { ExecutePatchError } from "../src/types.ts";

const workspaceRoot = new URL("../../../../../..", import.meta.url).pathname;
const releaseBinary = join(
	workspaceRoot,
	"target",
	"release",
	process.platform === "win32" ? "apply_patch.exe" : "apply_patch",
);
const originalOverride = process.env["PI_APPLY_PATCH_BIN"];
const codeModeAdaptersKey = Symbol.for("pi-code-mode/nested-tool-adapters/v2");
const presentationTheme = {
	name: "patch-view",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[39m",
	getBgAnsi: () => "\x1b[49m",
} as never as Theme;

beforeAll(() => {
	process.env["PI_APPLY_PATCH_BIN"] = releaseBinary;
});

afterAll(() => {
	if (originalOverride === undefined) delete process.env["PI_APPLY_PATCH_BIN"];
	else process.env["PI_APPLY_PATCH_BIN"] = originalOverride;
});

afterEach(() => {
	configureTuiAppearance(DEFAULT_TUI_APPEARANCE);
	Reflect.deleteProperty(globalThis, codeModeAdaptersKey);
});

test("the binary override resolves a real executable", () => {
	expect(resolveApplyPatchBinary({ PI_APPLY_PATCH_BIN: releaseBinary })).toBe(releaseBinary);
});

test("the default binary resolves from the root release target", () => {
	expect(resolveApplyPatchBinary({})).toBe(releaseBinary);
});

test("manual-edit guidance is conditional on apply_patch being exposed", () => {
	const tool = createApplyPatchTool();
	expect(tool.description).toStartWith(
		"Use apply_patch for manual file edits. This is a freeform tool, so do not wrap the patch in JSON.",
	);
});

test("the Rust command applies add, update, and delete actions", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-apply-patch-"));
	try {
		await writeFile(join(cwd, "edit.txt"), "old\n");
		await writeFile(join(cwd, "delete.txt"), "gone\n");
		const result = await executePatchWithRust({
			cwd,
			binary: releaseBinary,
			patchText: `*** Begin Patch
*** Add File: add.txt
+new
*** Update File: edit.txt
@@
-old
+newer
*** Delete File: delete.txt
*** End Patch`,
		});

		expect(await readFile(join(cwd, "add.txt"), "utf8")).toBe("new\n");
		expect(await readFile(join(cwd, "edit.txt"), "utf8")).toBe("newer\n");
		expect(result.changedFiles).toEqual(["add.txt", "edit.txt", "delete.txt"]);
		expect(result.createdFiles).toEqual(["add.txt"]);
		expect(result.deletedFiles).toEqual(["delete.txt"]);
		expect(result.fuzz).toBe(0);
		expect(result.diff).toContain("--- /dev/null\n+++ b/add.txt");
		expect(result.diff).toContain("--- a/edit.txt\n+++ b/edit.txt");
		expect(result.diff).toContain("--- a/delete.txt\n+++ /dev/null");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("the Rust command reports real ranges for separated bare patch sections", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-apply-patch-ranges-"));
	try {
		await writeFile(
			join(cwd, "separated.txt"),
			`${Array.from({ length: 30 }, (_, index) => `line ${String(index + 1).padStart(2, "0")}`).join("\n")}\n`,
		);
		const result = await executePatchWithRust({
			cwd,
			binary: releaseBinary,
			patchText: `*** Begin Patch
*** Update File: separated.txt
@@
-line 03
+line 03 changed
@@
-line 15
+line 15 changed
@@
-line 28
+line 28 changed
*** End Patch`,
		});
		const model = parseUnifiedDiff(result.diff ?? "");
		const hunks = model.files[0]?.hunks ?? [];

		expect(hunks).toHaveLength(3);
		expect(
			hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "removed").map((line) => line.oldLine)),
		).toEqual([3, 15, 28]);
		expect(
			hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "added").map((line) => line.newLine)),
		).toEqual([3, 15, 28]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("completed presentation uses the native ranges for separated bare patch sections", () => {
	const patch = `*** Begin Patch
*** Update File: separated.txt
@@
-line 03
+line 03 changed
@@
-line 15
+line 15 changed
@@
-line 28
+line 28 changed
*** End Patch`;
	const result = createApplyPatchSuccessResult(
		{
			changedFiles: ["separated.txt"],
			createdFiles: [],
			deletedFiles: [],
			movedFiles: [],
			fuzz: 0,
			diff: `--- a/separated.txt
+++ b/separated.txt
@@ -2,3 +2,3 @@
 line 02
-line 03
+line 03 changed
 line 04
@@ -14,3 +14,3 @@
 line 14
-line 15
+line 15 changed
 line 16
@@ -27,3 +27,3 @@
 line 27
-line 28
+line 28 changed
 line 29
`,
		},
		[{ operation: "update", path: "separated.txt" }],
		1,
	);
	const rendered = Bun.stripANSI(
		renderApplyPatchResult(
			result,
			{ expanded: true, isPartial: false },
			presentationTheme,
			{ executionStarted: true, isError: false },
			patch,
		)
			.render(100)
			.join("\n"),
	);

	expect(rendered).toContain("@@ -2,3 +2,3 @@");
	expect(rendered).toContain("@@ -14,3 +14,3 @@");
	expect(rendered).toContain("@@ -27,3 +27,3 @@");
	expect(rendered).toContain("┋ 28 line 28");
	expect(rendered).not.toContain("@@ -1,3 +1,3 @@");
});

test("a later failure reports the committed prefix", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-apply-patch-partial-"));
	try {
		const error = await executePatchWithRust({
			cwd,
			binary: releaseBinary,
			patchText: `*** Begin Patch
*** Add File: kept.txt
+kept
*** Update File: missing.txt
@@
-old
+new
*** End Patch`,
		}).catch((value: unknown) => value);

		expect(error).toBeInstanceOf(ExecutePatchError);
		expect((error as ExecutePatchError).hasPartialSuccess()).toBe(true);
		expect((error as ExecutePatchError).result.changedFiles).toEqual(["kept.txt"]);
		expect(await readFile(join(cwd, "kept.txt"), "utf8")).toBe("kept\n");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("the Pi tool returns a partial failure without hiding successful edits", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-apply-patch-tool-partial-"));
	try {
		const tool = createApplyPatchTool();
		const updates: unknown[] = [];
		const result = await tool.execute(
			"call-1",
			{
				input: `*** Begin Patch
*** Add File: kept.txt
+kept
*** Update File: missing.txt
@@
-old
+new
*** End Patch`,
			},
			new AbortController().signal,
			(update) => updates.push(update),
			{ cwd } as never,
		);

		expect(updates).toEqual([
			expect.objectContaining({
				content: [],
				details: expect.objectContaining({
					status: "running",
					progress: { completed: 0, total: 2 },
				}),
			}),
		]);

		expect(result.details).toMatchObject({
			version: 1,
			tool: "apply_patch",
			status: "partial_failure",
			input: {
				operations: [
					{ operation: "add", path: "kept.txt" },
					{ operation: "update", path: "missing.txt" },
				],
			},
			affectedPaths: ["kept.txt", "missing.txt"],
			files: [
				{ operation: "add", path: "kept.txt", status: "applied" },
				{ operation: "update", path: "missing.txt", status: "failed" },
			],
			counts: { planned: 2, applied: 1, failed: 1, changed: 1 },
			progress: { completed: 1, total: 2 },
			failure: { failedTargets: ["missing.txt"] },
		});
		expect(result.details.timing.durationMs).toBeGreaterThanOrEqual(0);
		expect(JSON.parse(JSON.stringify(result.details))).toEqual(result.details);
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("MUST NOT reapply");
		expect(await readFile(join(cwd, "kept.txt"), "utf8")).toBe("kept\n");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("the patch presentation builds a structured multi-file preview", () => {
	const model = patchPreviewModel(`*** Begin Patch
*** Add File: added.txt
+one
+two
*** Update File: changed.txt
@@
-old
+new
*** End Patch`);

	expect(model.files.map((file) => file.newPath ?? file.oldPath)).toEqual(["added.txt", "changed.txt"]);
	expect(model).toMatchObject({ additions: 3, removals: 1 });
	expect(model.files[1]?.hunks[0]?.lines.map((line) => line.kind)).toEqual(["removed", "added"]);
	expect(model.files[0]?.hunks[0]?.lines.map((line) => line.newLine)).toEqual([1, 2]);
	expect(model.files[1]?.hunks[0]?.lines.map((line) => [line.oldLine, line.newLine])).toEqual([
		[1, undefined],
		[undefined, 1],
	]);
	expect(model.files[1]?.hunks).toHaveLength(1);
	expect(model.files[1]?.hunks[0]?.header).toBe("@@ -1,1 +1,1 @@");
	const richHunk = patchPreviewModel(`*** Begin Patch
*** Update File: changed.txt
@@ -77,14 +77,14 @@ objc2-foundation = { version: "0.3", default-features = false, features = [
-old
+new
*** End Patch`);
	expect(richHunk.files[0]?.hunks[0]?.header).toBe(
		'@@ -77,14 +77,14 @@ objc2-foundation = { version: "0.3", default-features = false, features = [',
	);
	expect(richHunk.files[0]?.hunks[0]?.lines.map((line) => [line.oldLine, line.newLine])).toEqual([
		[77, undefined],
		[undefined, 77],
	]);
	expect(
		patchPreviewModel(`*** Begin Patch
*** Add File: added.txt
+one
+two
*** Update File: changed.txt
@@
-old
+new
*** End Patch`),
	).toBe(model);
});

test("uses semantic edit, warning, and error markers for patch lifecycle states", () => {
	const patch = "*** Begin Patch\n*** Add File: marker.ts\n+one\n*** End Patch";
	const operations = [{ operation: "add" as const, path: "marker.ts" }];
	const success = createApplyPatchSuccessResult(
		{ changedFiles: ["marker.ts"], createdFiles: ["marker.ts"], deletedFiles: [], movedFiles: [], fuzz: 0 },
		operations,
		1,
	);
	const partial = {
		...success,
		details: {
			...success.details,
			status: "partial_failure" as const,
			failure: { message: "partial", failedTargets: ["marker.ts"] },
		},
	};
	const successText = Bun.stripANSI(
		renderApplyPatchResult(
			success,
			{ expanded: false, isPartial: false },
			presentationTheme,
			{
				executionStarted: true,
				isError: false,
			},
			patch,
		).render(80)[0]!,
	);
	const warningText = Bun.stripANSI(
		renderApplyPatchResult(
			partial,
			{ expanded: false, isPartial: false },
			presentationTheme,
			{
				executionStarted: true,
				isError: false,
			},
			patch,
		).render(80)[0]!,
	);
	const errorText = Bun.stripANSI(
		renderApplyPatchResult(
			{ content: [{ type: "text", text: "Edit failed" }], details: undefined as never },
			{ expanded: false, isPartial: false },
			presentationTheme,
			{ executionStarted: true, isError: true },
			patch,
		).render(80)[0]!,
	);

	expect(successText).toContain(`${icon("edit")} Edited`);
	expect(warningText).toContain(`${icon("warning")} Partially edited`);
	expect(errorText).toContain(`${icon("error")} Edit failed`);
});

test("oversized patch previews stay visible and report truncation", () => {
	const model = patchPreviewModel(`*** Begin Patch\n*** Add File: large.txt\n+${"x".repeat(1_000_100)}\n*** End Patch`);
	expect(model.files).toHaveLength(1);
	expect(model.files[0]?.newPath).toBe("large.txt");
	expect(model.truncated).toBe(true);
});

test("bare apply_patch separators stay inside one logical diff change", () => {
	const model = patchPreviewModel(`*** Begin Patch
*** Update File: repeated.txt
@@
-old one
+new one
@@
-old two
+new two
*** End Patch`);
	const file = model.files[0]!;
	expect(file.hunks).toHaveLength(1);
	expect(file.hunks[0]?.header).toBe("@@ -1,2 +1,2 @@");
	expect(file.hunks[0]?.lines).toHaveLength(4);
});

test("delete previews keep one deletion label", () => {
	const model = patchPreviewModel(`*** Begin Patch
*** Delete File: removed.txt
*** End Patch`);
	expect(model.files[0]?.headerLines).toEqual(["file deleted"]);
	expect(model.files[0]?.hunks).toHaveLength(0);
});

test("reuses the shared activity from a running patch update through its final result", () => {
	const patch = `*** Begin Patch
*** Add File: streamed.ts
+authoritative
*** End Patch`;
	const operations = [{ operation: "add" as const, path: "streamed.ts" }];
	const running = createApplyPatchRunningResult(operations);
	const completed = createApplyPatchSuccessResult(
		{ changedFiles: ["streamed.ts"], createdFiles: ["streamed.ts"], deletedFiles: [], movedFiles: [], fuzz: 0 },
		operations,
		1,
	);
	const active = renderApplyPatchResult(
		running,
		{ expanded: false, isPartial: true },
		presentationTheme,
		{ executionStarted: true, isError: false, state: {} },
		patch,
	);
	const final = renderApplyPatchResult(
		completed,
		{ expanded: false, isPartial: false },
		presentationTheme,
		{ executionStarted: true, isError: false, state: {}, lastComponent: active },
		patch,
	);
	const rendered = Bun.stripANSI(final.render(80).join("\n"));
	expect(final).toBe(active);
	expect(rendered).toContain("Edited");
	expect(rendered).not.toContain("Editing");
	expect(rendered).toContain("streamed.ts");
	expect(rendered).toContain("authoritative");
});

test("the host can select compact or full diff modes", () => {
	const added = Array.from({ length: 80 }, (_, index) => `+line ${index}`).join("\n");
	const patch = `*** Begin Patch\n*** Add File: many.txt\n${added}\n*** End Patch`;
	const result = createApplyPatchSuccessResult(
		{ changedFiles: ["many.txt"], createdFiles: ["many.txt"], deletedFiles: [], movedFiles: [], fuzz: 0 },
		[{ operation: "add", path: "many.txt" }],
		1,
	);
	const expanded = renderApplyPatchResult(
		result,
		{ expanded: true, isPartial: false },
		presentationTheme,
		{ executionStarted: true, isError: false },
		patch,
	);
	const compact = renderApplyPatchResult(
		result,
		{ expanded: false, isPartial: false },
		presentationTheme,
		{ executionStarted: true, isError: false },
		patch,
	);
	const expandedRows = expanded.render(80).length;
	const compactLines = compact.render(80);
	const collapsedRows = compactLines.length;
	const compactText = Bun.stripANSI(compactLines.join("\n"));

	expect(compactLines[0]).toMatch(/\x1b\[48;(?:2|5);/u);
	expect(expandedRows).toBeGreaterThanOrEqual(collapsedRows);
	expect(expandedRows).toBeLessThanOrEqual(27);
	expect(collapsedRows).toBeLessThanOrEqual(27);
	expect(compactText).not.toMatch(/… \d+ rows omitted …/u);
	expect(compactText).not.toContain("expand diff");
	expect(compactText).not.toContain("└");
	expect(compactText).not.toContain("new file many.txt");
	expect(compactText).toContain("@@ -0,0 +1,80 @@");
	expect(compactText).toContain("┃  1 line 0");
	expect(compactLines.filter((line) => Bun.stripANSI(line).includes("@@ -0,0 +1,80 @@"))[1]).toContain("\x1b[48;");

	const disclosure = compact.children[0] as unknown as {
		onMouse(event: {
			type: "press" | "release";
			row: number;
			col: number;
			screenRow: number;
			screenCol: number;
			button: 0 | 2;
			wheel: undefined;
			shift: false;
			alt: false;
			ctrl: false;
		}): boolean;
	};
	const body = compact.children[1] as unknown as {
		onMouse(event: {
			type: "press" | "release" | "wheel";
			row: number;
			col: number;
			screenRow: number;
			screenCol: number;
			button?: 0 | 2;
			wheel?: 1;
			shift: false;
			alt: false;
			ctrl: false;
		}): boolean;
	};
	const event = {
		row: 0,
		col: 2,
		screenRow: 0,
		screenCol: 2,
		button: 0 as const,
		wheel: undefined,
		shift: false as const,
		alt: false as const,
		ctrl: false as const,
	};
	const omissionRow = compactLines.findIndex((line) => Bun.stripANSI(line).includes("↕"));
	expect(omissionRow).toBeGreaterThan(1);
	const omissionEvent = { ...event, row: omissionRow - 1, screenRow: omissionRow };
	expect(body.onMouse({ ...omissionEvent, type: "press" })).toBe(true);
	expect(body.onMouse({ ...omissionEvent, type: "release" })).toBe(true);
	expect(compact.render(80).length).toBe(expandedRows);
	expect(Bun.stripANSI(compact.render(80).join("\n"))).toContain("⌄");
	expect(Bun.stripANSI(compact.render(80).join("\n"))).toContain("Edited");
	const beforeScroll = Bun.stripANSI(compact.render(80).join("\n"));
	let handledWheels = 0;
	for (let index = 0; index < 24; index += 1)
		if (body.onMouse({ ...event, type: "wheel", button: undefined, wheel: 1 })) handledWheels += 1;
	const afterScroll = Bun.stripANSI(compact.render(80).join("\n"));
	expect(handledWheels).toBeGreaterThan(0);
	expect(afterScroll).not.toBe(beforeScroll);
	expect(afterScroll).toContain("line 79");
	expect(compact.render(80).length).toBe(expandedRows);
	// The expanded header folds. Primary body clicks remain selection-safe in the shared component contract.
	expect(disclosure.onMouse({ ...event, type: "press" })).toBe(true);
	expect(disclosure.onMouse({ ...event, type: "release" })).toBe(true);
	expect(compact.render(80).length).toBe(collapsedRows);
});

test("a completed trace overrides stale resumed running presentation details", () => {
	const patch = "*** Begin Patch\n*** Add File: resumed.ts\n+export const resumed = true;\n*** End Patch";
	const completed = createApplyPatchSuccessResult(
		{ changedFiles: ["resumed.ts"], createdFiles: ["resumed.ts"], deletedFiles: [], movedFiles: [], fuzz: 0 },
		[{ operation: "add", path: "resumed.ts" }],
		1,
	);
	const stale = { ...completed, details: { ...completed.details, status: "running" } } as never;
	const rendered = Bun.stripANSI(
		renderApplyPatchResult(
			stale,
			{ expanded: false, isPartial: false },
			presentationTheme,
			{ executionStarted: true, isError: false },
			patch,
		).render(80)[0] ?? "",
	);
	expect(rendered).toContain("Edited");
	expect(rendered).not.toContain("Editing");
});

test("malformed partial-failure details render a compact failure", () => {
	const patch = "*** Begin Patch\n*** Add File: malformed.ts\n+one\n*** End Patch";
	const rendered = Bun.stripANSI(
		renderApplyPatchResult(
			{
				content: [{ type: "text", text: "Edit failed" }],
				details: { version: 1, tool: "apply_patch", status: "partial_failure" } as never,
			},
			{ expanded: false, isPartial: false },
			presentationTheme,
			{ executionStarted: true, isError: true },
			patch,
		).render(80)[0] ?? "",
	);
	expect(rendered).toContain("Edit failed");
});

test("malformed replay arguments do not crash result presentation", () => {
	const tool = createApplyPatchTool();
	const component = tool.renderResult!(
		{ content: [{ type: "text", text: "Edit failed" }], details: {} as never },
		{ expanded: false, isPartial: false },
		presentationTheme,
		{ args: null, executionStarted: true, isError: true, invalidate() {}, state: {} } as never,
	);
	expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Edit failed");
});

describe("Pi registration", () => {
	test("the extension registers apply_patch directly and marks partial results as errors", () => {
		let toolName: string | undefined;
		let resultHandler: ((event: { toolName: string; details?: unknown }) => unknown) | undefined;
		const pi = {
			registerTool(tool: { name: string }) {
				toolName = tool.name;
			},
			on(event: string, handler: (event: { toolName: string; details?: unknown }) => unknown) {
				if (event === "tool_result") resultHandler = handler;
			},
		} as unknown as ExtensionAPI;

		applyPatchExtension(pi);

		expect(toolName).toBe("apply_patch");
		expect(resultHandler?.({ toolName: "apply_patch", details: { status: "partial_failure" } })).toEqual({
			isError: true,
		});
		expect(resultHandler?.({ toolName: "apply_patch", details: { status: "success" } })).toBeUndefined();
	});

	test("the direct tool owns its presentation shell", () => {
		expect(createApplyPatchTool().renderShell).toBe("self");
	});

	test("declares the direct tool as native freeform grammar input", () => {
		expect(createApplyPatchTool().constrainedSampling).toMatchObject({
			type: "grammar",
			variants: { openai_lark: expect.stringContaining('begin_patch: "*** Begin Patch" LF') },
		});
	});

	test("the Code Mode adapter applies raw patch text with the registered tool", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-apply-patch-code-mode-"));
		const adapters = getCodeModeToolAdapterRegistry().adapters;
		const previousAdapter = adapters.get("apply_patch");
		adapters.delete("apply_patch");
		try {
			let registeredTool: unknown;
			const handlers = new Map<string, (event: { reason?: string }) => unknown>();
			const pi = {
				registerTool(tool: unknown) {
					registeredTool = tool;
				},
				on(event: string, handler: (event: { reason?: string }) => unknown) {
					handlers.set(event, handler);
				},
			} as unknown as ExtensionAPI;

			applyPatchExtension(pi);
			const adapter = adapters.get("apply_patch");
			expect(adapter?.kind).toBe("freeform");
			expect(adapter).not.toHaveProperty("exposure");
			expect(registeredTool).toBeDefined();

			const result = await adapter?.invoke(
				`*** Begin Patch
*** Add File: code-mode.txt
+code mode
*** End Patch`,
				{
					cwd,
					toolCallId: "code-mode-call",
					extensionContext: { cwd } as never,
				},
				new AbortController().signal,
			);

			expect(result).toMatchObject({
				details: {
					version: 1,
					tool: "apply_patch",
					status: "success",
					input: { operations: [{ operation: "add", path: "code-mode.txt" }] },
					affectedPaths: ["code-mode.txt"],
					files: [{ operation: "add", path: "code-mode.txt", status: "applied" }],
					counts: { planned: 1, applied: 1, failed: 0, created: 1 },
					progress: { completed: 1, total: 1 },
				},
			});
			expect(JSON.parse(JSON.stringify((result as { details: unknown }).details))).toEqual(
				(result as { details: unknown }).details,
			);
			expect(result && adapter?.resultValue?.(result)).toMatchObject({
				changedFiles: ["code-mode.txt"],
				createdFiles: ["code-mode.txt"],
			});
			if (!result) throw new Error("Code Mode apply_patch returned no result");
			const presentation = adapter?.renderTrace?.(
				{
					id: "apply-patch-presentation",
					input: `*** Begin Patch
*** Add File: code-mode.txt
+code mode
*** End Patch`,
					status: "done",
					durationMs: 1,
					result,
				},
				{ theme: presentationTheme, requestRender() {}, lastComponent: undefined, cwd, state: {} },
			);
			const rendered = Bun.stripANSI(presentation?.render(80).join("\n") ?? "");
			expect(rendered).toContain("Edited · code-mode.txt");
			expect(rendered).not.toContain("Changes");
			expect(rendered).toContain("code-mode.txt");
			expect(rendered).toContain("code mode");
			expect(rendered).not.toContain("Input");
			expect(rendered).not.toContain("Changed files:");
			expect(await readFile(join(cwd, "code-mode.txt"), "utf8")).toBe("code mode\n");

			const partial = adapter!.invoke(
				`*** Begin Patch
*** Add File: code-mode-kept.txt
+kept
*** Update File: code-mode-missing.txt
@@
-old
+new
*** End Patch`,
				{
					cwd,
					toolCallId: "code-mode-partial",
					extensionContext: { cwd } as never,
				},
				new AbortController().signal,
			);
			await expect(partial).rejects.toThrow("apply_patch partially failed");
			expect(handlers.has("session_shutdown")).toBe(true);
		} finally {
			if (previousAdapter === undefined) adapters.delete("apply_patch");
			else adapters.set("apply_patch", previousAdapter);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("reload disposal does not remove a replacement Code Mode adapter", () => {
		const adapters = getCodeModeToolAdapterRegistry().adapters;
		const previousAdapter = adapters.get("apply_patch");
		adapters.delete("apply_patch");
		try {
			const shutdownHandlers: Array<(event: { reason: string }) => unknown> = [];
			const pi = {
				registerTool() {},
				on(event: string, handler: (event: { reason: string }) => unknown) {
					if (event === "session_shutdown") shutdownHandlers.push(handler);
				},
			} as unknown as ExtensionAPI;

			applyPatchExtension(pi);
			const firstAdapter = adapters.get("apply_patch");
			applyPatchExtension(pi);
			const replacementAdapter = adapters.get("apply_patch");
			expect(replacementAdapter).not.toBe(firstAdapter);

			shutdownHandlers[0]?.({ reason: "reload" });
			expect(adapters.get("apply_patch")).toBe(replacementAdapter);
			shutdownHandlers[1]?.({ reason: "quit" });
			expect(adapters.get("apply_patch")).toBeUndefined();
		} finally {
			if (previousAdapter === undefined) adapters.delete("apply_patch");
			else adapters.set("apply_patch", previousAdapter);
		}
	});
});
