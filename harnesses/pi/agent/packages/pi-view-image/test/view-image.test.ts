import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomEditor, type Theme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { ToolActivity } from "@luan.sh/pi-libtui/tool";
import {
	EDITOR_PROTOCOL,
	type EditorFactory,
	type EditorPasteHandler,
	type EditorRegistry,
	type EditorRenderDecorator,
} from "@luan.sh/pi-libtui/editor";
import { ImageAttachmentStore, pastedImagePath } from "../src/core/attachments.ts";
import { parseViewImageOutput } from "../src/native/view-image.ts";
import { labelNativeImageAttachments } from "../src/native-attachments.ts";
import { transformPendingImageAttachments } from "../src/runtime/attachments.ts";
import { installImageAttachmentSession } from "../src/runtime/editor-attachments.ts";
import {
	configureViewImageToolForModel,
	createViewImageTool,
	effectiveViewImageParams,
	parseViewImageParams,
	supportsOriginalImageDetail,
	supportsViewImageInputs,
} from "../src/tools/view-image/definition.ts";
import { renderViewImageResult } from "../src/tools/view-image/presentation.ts";
import { createViewImageResult, type ViewImageContent } from "../src/tools/view-image/result.ts";

const theme = {
	name: "view-image-test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[38;2;240;240;240m",
	getBgAnsi: () => "\x1b[48;2;30;34;40m",
} as never as Theme;

describe("view_image", () => {
	test("registers image attachment handlers without patching the editor host", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-view-image-paste-"));
		const path = join(directory, "screen shot.png");
		await writeFile(
			path,
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		try {
			expect(pastedImagePath(`'${path}'`, directory)).toBe(path);
			const store = new ImageAttachmentStore();
			const handleInput = CustomEditor.prototype.handleInput;
			const insertTextAtCursor = CustomEditor.prototype.insertTextAtCursor;
			const render = CustomEditor.prototype.render;
			let pasteHandler: EditorPasteHandler | undefined;
			let renderDecorator: EditorRenderDecorator | undefined;
			const registry: EditorRegistry = {
				protocol: EDITOR_PROTOCOL,
				version: 1,
				registerPasteHandler(handler) {
					pasteHandler = handler;
					return () => {
						if (pasteHandler === handler) pasteHandler = undefined;
					};
				},
				registerRenderDecorator(decorator) {
					renderDecorator = decorator;
					return () => {
						if (renderDecorator === decorator) renderDecorator = undefined;
					};
				},
			};
			let factory: EditorFactory | undefined;
			const ui = {
				getEditorComponent: () => factory,
				setEditorComponent: (next: EditorFactory | undefined) => {
					factory = next;
				},
			};
			const removeSession = installImageAttachmentSession(
				{ cwd: directory, ui, getTheme: () => theme, store },
				registry,
			);
			try {
				expect(CustomEditor.prototype.handleInput).toBe(handleInput);
				expect(CustomEditor.prototype.insertTextAtCursor).toBe(insertTextAtCursor);
				expect(CustomEditor.prototype.render).toBe(render);
				const token = pasteHandler?.handle(path);
				expect(token).toMatch(/^[\u{f0000}-\u{ffffd}] $/u);
				expect(renderDecorator?.decorate([token ?? ""], 40).join("\n")).toContain("Image #1");
			} finally {
				removeSession();
			}
			expect(pasteHandler).toBeUndefined();
			expect(renderDecorator).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true });
		}
	});

	test("restores saved image tags as pills and keeps stash text portable across sessions", async () => {
		let factory: EditorFactory | undefined;
		const ui = {
			getEditorComponent: () => factory,
			setEditorComponent: (next: EditorFactory | undefined) => {
				factory = next;
			},
		};
		const store = new ImageAttachmentStore();
		let renderDecorator: EditorRenderDecorator | undefined;
		const registry: EditorRegistry = {
			protocol: EDITOR_PROTOCOL,
			version: 1,
			registerPasteHandler: () => () => {},
			registerRenderDecorator: (decorator) => {
				renderDecorator = decorator;
				return () => {};
			},
		};
		const remove = installImageAttachmentSession({ cwd: "/tmp", ui, getTheme: () => theme, store }, registry);
		try {
			// type-boundary: this test supplies only the host methods used by the native editor.
			type EditorHostBoundary = unknown;
			const terminal = new ProcessTerminal();
			terminal.write = () => {};
			const tui = new TuiAltScreen(terminal);
			const keys = { matches: () => false } as EditorHostBoundary as KeybindingsManager;
			const editor = factory!(tui, {} as never, keys);
			const saved =
				'<file name="/tmp/screen &amp; &quot;one&quot;.png"></file>\n<file name="/tmp/two.webp"></file>\ncompare';
			editor.setText(saved);
			expect(editor.getText()).not.toContain("<file");
			const rendered = renderDecorator!.decorate(editor.render(80), 80).join("\n");
			expect(rendered).toContain("Image #1");
			expect(rendered).toContain("Image #2");
			expect(editor.getExpandedText?.()).toBe(saved);
			editor.setText("");
			store.clear();
			editor.setText(saved);
			const loaded: string[] = [];
			let submitted = "";
			editor.onSubmit = (text) => {
				submitted = text;
			};
			editor.handleInput("\r");
			const result = await transformPendingImageAttachments({ text: submitted }, store, async (path) => {
				loaded.push(path);
				return { path, data: "IMAGE", mimeType: "image/png", width: 1, height: 1, bytes: 1, detail: "high" };
			});
			expect(loaded).toEqual(['/tmp/screen & "one".png', "/tmp/two.webp"]);
			expect(result?.images).toHaveLength(2);
			const literal =
				'`<file name="/tmp/example.png"></file>`\n```xml\n<file name="/tmp/example.png"></file>\n```\n<file name="/tmp/notes.txt">text</file>';
			editor.setText(literal);
			expect(editor.getText()).toBe(literal);
		} finally {
			remove();
		}
	});

	test("renumbers surviving attachment tokens in editor order", () => {
		const store = new ImageAttachmentStore();
		const first = store.add("/tmp/one.png");
		const second = store.add("/tmp/two.png");
		expect(store.presentations(`${first} ${second}`)).toEqual([
			{ token: first, label: "Image #1", icon: "view-image", iconTone: { hue: "magenta", shade: 2 } },
			{ token: second, label: "Image #2", icon: "view-image", iconTone: { hue: "magenta", shade: 2 } },
		]);
		expect(store.presentations(second)).toEqual([
			{ token: second, label: "Image #1", icon: "view-image", iconTone: { hue: "magenta", shade: 2 } },
		]);
	});

	test("expands inline attachment tokens into provider images at submission", async () => {
		const store = new ImageAttachmentStore();
		const first = store.add("/tmp/one.png");
		const second = store.add("/tmp/two.webp");
		const transformed = await transformPendingImageAttachments(
			{ text: `compare ${first} and ${second}` },
			store,
			async (path) => ({
				data: path.includes("one") ? "ONE" : "TWO",
				mimeType: path.endsWith("png") ? "image/png" : "image/webp",
				detail: "original",
				path,
				width: 1,
				height: 1,
				bytes: 1,
			}),
		);
		expect(transformed).toEqual({
			text: 'compare <file name="/tmp/one.png"></file>\n and <file name="/tmp/two.webp"></file>\n',
			images: [
				{ type: "image", data: "ONE", mimeType: "image/png" },
				{ type: "image", data: "TWO", mimeType: "image/webp" },
			],
			failures: [],
		});
	});
	test("labels native image attachments with the Codex content sequence", () => {
		const messages = [
			{
				role: "user" as const,
				timestamp: 1,
				content: [
					{
						type: "text" as const,
						text: '<file name="/tmp/screenshot.png"></file>\nwhat do you see',
					},
					{ type: "image" as const, data: "AAAA", mimeType: "image/png" },
				],
			},
		];

		expect(JSON.stringify(labelNativeImageAttachments(messages)?.[0])).toBe(
			JSON.stringify({
				role: "user",
				timestamp: 1,
				content: [
					{ type: "text", text: '<image name=[Image #1] path="/tmp/screenshot.png">' },
					{ type: "image", data: "AAAA", mimeType: "image/png", detail: "high" },
					{ type: "text", text: "</image>" },
					{ type: "text", text: "what do you see" },
				],
			}),
		);
	});

	test("preserves unrelated file tags and declines ambiguous image metadata", () => {
		const textFile = {
			role: "user" as const,
			timestamp: 1,
			content: [
				{ type: "text" as const, text: '<file name="/tmp/notes.txt">hello</file>\nquestion' },
				{ type: "image" as const, data: "AAAA", mimeType: "image/png" },
			],
		};
		expect(labelNativeImageAttachments([textFile])).toBeUndefined();
	});

	test("pairs multiple images while preserving text-file context", () => {
		const messages = [
			{
				role: "user" as const,
				timestamp: 1,
				content: [
					{
						type: "text" as const,
						text: '<file name="/tmp/notes.txt">notes</file>\n<file name="/tmp/one.png"></file>\n<file name="/tmp/two.webp">resized</file>\ncompare them',
					},
					{ type: "image" as const, data: "ONE", mimeType: "image/png" },
					{ type: "image" as const, data: "TWO", mimeType: "image/webp" },
				],
			},
		];

		const normalized = labelNativeImageAttachments(messages)?.[0];
		expect(JSON.stringify(normalized)).toContain('<file name=\\"/tmp/notes.txt\\">notes</file>');
		expect(JSON.stringify(normalized)).toContain('<image name=[Image #1] path=\\"/tmp/one.png\\">');
		expect(JSON.stringify(normalized)).toContain('<image name=[Image #2] path=\\"/tmp/two.webp\\">');
		expect(JSON.stringify(normalized)).toContain("resized");
		expect(JSON.stringify(normalized)).toContain("compare them");
	});

	test("normalizes Codex-compatible paths and detail", () => {
		expect(parseViewImageParams({ path: "@fixtures/image.png" })).toEqual({
			path: "fixtures/image.png",
			detail: "high",
		});
		expect(parseViewImageParams({ path: "image.png", detail: "original" }).detail).toBe("original");
		expect(() => parseViewImageParams({ path: "image.png", detail: "low" })).toThrow(
			"only supports `high` or `original`",
		);
	});

	test("accepts image capability independently of provider", () => {
		expect(supportsViewImageInputs({ input: ["text", "image"] })).toBe(true);
		expect(supportsViewImageInputs({ input: ["text"] })).toBe(false);
		expect(supportsViewImageInputs(undefined)).toBe(false);
	});

	test("matches Codex original-detail capability while keeping other vision providers supported", () => {
		expect(
			supportsOriginalImageDetail({
				provider: "openai-codex",
				input: ["image"],
				compat: { supportsImageDetailOriginal: true },
			}),
		).toBe(true);
		expect(supportsOriginalImageDetail({ provider: "openai-codex", input: ["image"] })).toBe(false);
		expect(supportsOriginalImageDetail({ provider: "anthropic", input: ["image"] })).toBe(true);

		const tool = createViewImageTool();
		configureViewImageToolForModel(tool, { provider: "openai-codex", input: ["image"] });
		expect(tool.parameters.properties).not.toHaveProperty("detail");
		configureViewImageToolForModel(tool, {
			provider: "openai-codex",
			input: ["image"],
			compat: { supportsImageDetailOriginal: true },
		});
		expect(tool.parameters.properties).toHaveProperty("detail");
		expect(
			effectiveViewImageParams(
				{ path: "image.png", detail: "original" },
				{ provider: "openai-codex", input: ["image"] },
			).detail,
		).toBe("high");
	});

	test("parses the native attachment and builds Pi image content", () => {
		const output = parseViewImageOutput(
			JSON.stringify({
				image_url: "data:image/png;base64,AAAA",
				detail: "high",
				path: "/tmp/image.png",
				width: 4,
				height: 3,
				bytes: 4,
			}),
		);
		const result = createViewImageResult({ path: "image.png", detail: "high" }, output, 2);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ type: "image", data: "AAAA", mimeType: "image/png" });
		expect((result.content[0] as ViewImageContent).detail).toBe("high");
		expect(result.details).toMatchObject({
			version: 1,
			tool: "view_image",
			status: "success",
			image: { path: "/tmp/image.png", width: 4, height: 3, bytes: 4 },
		});
	});

	test("renders a compact viewed-image action instead of the default tool blob", () => {
		const component = renderViewImageResult(
			{
				content: [],
				details: {
					version: 1,
					tool: "view_image",
					status: "success",
					input: { path: "/tmp/image.png", detail: "high" },
					image: { path: "/tmp/image.png", mimeType: "image/png", width: 4, height: 3, bytes: 4 },
					timing: { durationMs: 7 },
				},
			},
			theme,
			{ executionStarted: false, state: {}, invalidate() {}, lastComponent: undefined, isError: false },
		);
		expect(component.render(80)[0]!.replace(/\x1b\[[0-9;]*m/g, "")).toContain("Viewed image · 7ms");
	});

	test("image descriptions expand through Pi's public renderer context", () => {
		const result = createViewImageResult(
			{ path: "image.png", detail: "high" },
			{ path: "image.png", detail: "high", mimeType: "image/png", data: "AAAA", width: 1, height: 1, bytes: 3 },
			1,
		);
		result.details!.description = {
			model: "fixture/vision",
			text: Array.from({ length: 30 }, (_, index) => `Description line ${index}`).join("\n"),
		};
		const render = (expanded: boolean) =>
			createViewImageTool().renderResult!(result, { expanded, isPartial: false }, theme, {
				args: { path: "image.png" },
				toolCallId: "image",
				cwd: "/tmp",
				state: {},
				invalidate() {},
				lastComponent: undefined,
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				expanded,
				showImages: false,
				isError: false,
				durationMs: undefined,
				outputPad: 0,
			});
		const expanded = render(true);
		expect(expanded.render(100).length).toBeGreaterThan(render(false).render(100).length);
		if (!(expanded instanceof ToolActivity)) throw new Error("Expected the shared tool presentation");
		for (let index = 0; index < 30; index++) {
			expanded.onMouse({
				type: "wheel",
				row: 3,
				col: 4,
				screenRow: 3,
				screenCol: 4,
				button: undefined,
				wheel: 1,
				shift: false,
				alt: false,
				ctrl: false,
			});
			expanded.render(100);
		}
		expect(expanded.render(100).join("\n")).toContain("Description line 29");
	});

	test("rejects malformed native output", () => {
		expect(() => parseViewImageOutput('{"image_url":"https://example.test/image.png"}')).toThrow(
			"invalid native image attachment",
		);
	});
});
