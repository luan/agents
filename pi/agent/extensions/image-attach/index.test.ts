import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Editor, getImageDimensions } from "@earendil-works/pi-tui";
import { installEditorHandleHighlight, mergeHandleSegments } from "./editor";
import { PENDING_HANDLE } from "./handles";
import imageAttachExtension, {
	adoptImageFile,
	appendHandlePaths,
	collectImageAttachments,
	createReadImageLoader,
	findImagePathTokens,
	pastedImagePath,
	resolveImageHandles,
} from "./index";
import { pickCellColors } from "./thumbnail";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function image(data = PNG_BASE64) {
	return { type: "image" as const, data, mimeType: "image/png" };
}

async function withImageDir(run: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "image-attach-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

type TerminalInputListener = (data: string) => { consume?: boolean; data?: string } | undefined;

function inputHandler(loadImage: (path: string) => Promise<ReturnType<typeof image> | undefined>, cwd = "/repo") {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const sent: unknown[] = [];
	let listener: TerminalInputListener | undefined;
	imageAttachExtension(
		{
			on(event: string, next: never) {
				handlers.set(event, next as never);
			},
			registerShortcut() {},
			registerMessageRenderer() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		} as never,
		{ loadImage: (path) => loadImage(path) },
	);
	const input = handlers.get("input");
	if (!input) throw new Error("input handler was not registered");
	handlers.get("session_start")?.({}, {
		hasUI: true,
		cwd,
		ui: {
			onTerminalInput(next: TerminalInputListener) {
				listener = next;
				return () => {};
			},
			getEditorComponent: () => undefined,
			setEditorComponent() {},
			setWidget() {},
		},
	} as never);
	return {
		handle: (event: unknown, ctx: unknown) => input(event, ctx) as Promise<unknown>,
		get listener() {
			return listener;
		},
		sent,
	};
}

const multimodal = { cwd: "/repo", model: { input: ["text", "image"] } };

type TextSegment = { segment: string; index: number; input: string };

const BACKSPACE = "\x7f";
const DELETE_WORD_BACKWARD = "\x17";
const DELETE_WORD_FORWARD = "\x1bd";
const LINE_START = "\x01";

/** A real pi editor behind the layer — the only way to prove deletion actually goes whole. */
function realLayeredEditor() {
	const tui = { terminal: { rows: 40, columns: 100 }, requestRender() {} };
	const editor = new Editor(tui as never, { borderColor: (text: string) => text, selectList: {} } as never, {});
	return layeredEditor(editor as never) as unknown as Editor;
}

function layeredEditor(base: Record<string, unknown>) {
	let factory: ((...args: unknown[]) => Record<string, unknown>) | undefined;
	installEditorHandleHighlight({
		getEditorComponent: () => (() => base) as never,
		setEditorComponent: (next) => {
			factory = next as never;
		},
	} as never);
	if (!factory) throw new Error("editor factory was not installed");
	return factory({}, {}, {}) as {
		render: (width: number) => string[];
		transformEditorLine?: (line: string) => string;
		segment?: (text: string, mode: string) => Iterable<TextSegment>;
	};
}

describe("image path tokens", () => {
	test("matches path-shaped tokens and leaves bare filenames alone", () => {
		const text = "see /tmp/a.png and ./shots/b.jpeg and ~/c.webp but not diagram.png or https://x.com/d.png";
		expect(findImagePathTokens(text)).toEqual(["/tmp/a.png", "./shots/b.jpeg", "~/c.webp"]);
	});

	test("keeps drag-and-drop escaped spaces in one token", () => {
		expect(findImagePathTokens("/tmp/Screen\\ Shot.png")).toEqual(["/tmp/Screen\\ Shot.png"]);
	});
});

describe("collectImageAttachments", () => {
	test("attaches each existing image path once, in text order", async () => {
		await withImageDir(async (dir) => {
			const first = join(dir, "first.png");
			const second = join(dir, "second.png");
			await writeFile(first, Buffer.from(PNG_BASE64, "base64"));
			await writeFile(second, Buffer.from(PNG_BASE64, "base64"));

			const loaded: string[] = [];
			const attachments = await collectImageAttachments(
				`look at ${second} then ${first} then ${second} and ${join(dir, "missing.png")}`,
				dir,
				[],
				async (path) => {
					loaded.push(path);
					return image(path);
				},
			);

			expect(loaded).toEqual([second, first]);
			expect(attachments.map((a) => a.image.data)).toEqual([second, first]);
		});
	});

	test("attaches the file behind a pasted handle before bare paths", async () => {
		await withImageDir(async (dir) => {
			const pasted = join(dir, "pi-clipboard-1.png");
			const referenced = join(dir, "other.png");
			await writeFile(pasted, Buffer.from(PNG_BASE64, "base64"));
			await writeFile(referenced, Buffer.from(PNG_BASE64, "base64"));

			const attachments = await collectImageAttachments(
				`compare ${referenced} with [image #7]`,
				dir,
				[],
				async (path) => image(path),
				new Map([[7, pasted]]),
			);

			expect(attachments.map((a) => a.path)).toEqual([pasted, referenced]);
		});
	});

	test("skips an image another extension already attached", async () => {
		await withImageDir(async (dir) => {
			const path = join(dir, "pasted.png");
			await writeFile(path, Buffer.from(PNG_BASE64, "base64"));

			const attachments = await collectImageAttachments(`what is ${path}`, dir, [image()], async () => image());

			expect(attachments).toEqual([]);
		});
	});

	test("skips paths that resolve to a directory", async () => {
		await withImageDir(async (dir) => {
			const attachments = await collectImageAttachments(`${dir}/nope.png`, dir, [], async () => image());
			expect(attachments).toEqual([]);
		});
	});
});

describe("pasted image paths", () => {
	const paste = (payload: string) => `\x1b[200~${payload}\x1b[201~`;

	test("recognises a bare and a shell-quoted image path", async () => {
		await withImageDir(async (dir) => {
			const path = join(dir, "bootty-clipboard-1-0.png");
			await writeFile(path, Buffer.from(PNG_BASE64, "base64"));

			expect(pastedImagePath(paste(path), dir)).toBe(path);
			expect(pastedImagePath(paste(`'${path}'`), dir)).toBe(path);
		});
	});

	test("rewrites the paste into a handle instead of swallowing it", async () => {
		await withImageDir(async (dir) => {
			const path = join(dir, "bootty-clipboard-2-0.png");
			await writeFile(path, Buffer.from(PNG_BASE64, "base64"));
			const { listener } = inputHandler(async () => image(), dir);

			// A rewritten paste keeps the editor's own paste handling — and the TUI's repaint —
			// which a consumed event would skip, leaving the handle invisible until the next key.
			const result = listener?.(paste(path));

			expect(result).toEqual({ data: expect.stringMatching(/^\x1b\[200~\[image #\d+\] \x1b\[201~$/) });
			expect(listener?.(paste("plain text"))).toBeUndefined();
		});
	});

	test("ignores ordinary text, missing files, and multi-path pastes", async () => {
		await withImageDir(async (dir) => {
			const path = join(dir, "shot.png");
			await writeFile(path, Buffer.from(PNG_BASE64, "base64"));

			expect(pastedImagePath(paste("just some prose"), dir)).toBeUndefined();
			expect(pastedImagePath(paste(join(dir, "missing.png")), dir)).toBeUndefined();
			expect(pastedImagePath(paste(`${path}\n${path}`), dir)).toBeUndefined();
			expect(pastedImagePath(paste(join(dir, "notes.txt")), dir)).toBeUndefined();
			expect(pastedImagePath(path, dir)).toBeUndefined();
		});
	});
});

describe("atomic handles", () => {
	const graphemes = (text: string) => new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
	const segmentsOf = (text: string) => [...mergeHandleSegments(text, graphemes(text))].map((s) => s.segment);

	test("a handle is the single segment backspace deletes", () => {
		// The editor deletes `lastGrapheme.segment.length` characters before the cursor, so the
		// handle being one trailing segment is exactly what stops it eroding into "ge #12]".
		expect(segmentsOf("see [image #12]").at(-1)).toBe("[image #12]");
		expect(segmentsOf(`see ${PENDING_HANDLE}`).at(-1)).toBe(PENDING_HANDLE);
	});

	test("text around handles keeps its own segmentation", () => {
		expect(segmentsOf("a [image #1] b")).toEqual(["a", " ", "[image #1]", " ", "b"]);
	});

	test("every character survives the merge", () => {
		const text = "one [image #1] two [image #2] three";
		expect(segmentsOf(text).join("")).toBe(text);
	});

	test("lines without a handle pass the base segmentation straight through", () => {
		const text = "no handles here";
		const base = graphemes(text);
		expect(mergeHandleSegments(text, base)).toBe(base);
	});

	test("one backspace clears a whole handle in a real pi editor", () => {
		const editor = realLayeredEditor();

		editor.setText("look at [image #12]");
		editor.handleInput(BACKSPACE);
		expect(editor.getText()).toBe("look at ");

		// Text after a handle still deletes character by character; the handle only goes as a unit.
		editor.setText("look at [image #12] tail");
		for (let i = 0; i < 5; i++) editor.handleInput(BACKSPACE);
		expect(editor.getText()).toBe("look at [image #12]");
		editor.handleInput(BACKSPACE);
		expect(editor.getText()).toBe("look at ");
	});

	test("word delete takes the handle and stops there", () => {
		const editor = realLayeredEditor();

		// Without the motion snap the word walker runs past the handle and eats "at " with it.
		editor.setText("look at [image #12]");
		editor.handleInput(DELETE_WORD_BACKWARD);
		expect(editor.getText()).toBe("look at ");
		editor.handleInput(DELETE_WORD_BACKWARD);
		expect(editor.getText()).toBe("look ");

		editor.setText("[image #3] tail");
		editor.handleInput(LINE_START);
		editor.handleInput(DELETE_WORD_FORWARD);
		expect(editor.getText()).toBe(" tail");
	});

	test("word delete is untouched where there is no handle", () => {
		const editor = realLayeredEditor();
		editor.setText("plain words here");
		editor.handleInput(DELETE_WORD_BACKWARD);
		expect(editor.getText()).toBe("plain words ");
	});
});

describe("attachment payload", () => {
	/** Written with compression off, the way a raw RGBA encoder leaves a file. */
	function writeBloatedPng(path: string, size: string) {
		execFileSync("magick", [
			"-size",
			size,
			"xc:white",
			"-fill",
			"#24292f",
			"-draw",
			"rectangle 40,60 600,80",
			"-define",
			"png:compression-level=0",
			"-define",
			"png:compression-filter=0",
			`PNG32:${path}`,
		]);
	}

	test("re-encodes an image whose bytes are out of proportion to its size", async () => {
		await withImageDir(async (dir) => {
			const path = join(dir, "bloated.png");
			writeBloatedPng(path, "800x600");
			const fileBytes = statSync(path).size;

			const image = await createReadImageLoader()(path, {} as never);

			// pi's read tool caps dimensions, not wastefulness: 800x600 clears every limit, so an
			// uncompressed encode used to reach the model at full size.
			expect(fileBytes).toBeGreaterThan(1024 * 1024);
			expect(image?.data.length).toBeLessThan(fileBytes / 100);
			expect(getImageDimensions(image?.data ?? "", "image/png")).toMatchObject({ widthPx: 800, heightPx: 600 });
		});
	});

	test("copies a pasted original into a downscaled file of our own", async () => {
		await withImageDir(async (dir) => {
			// A file-flavoured clipboard hands over the app's own saved file, at whatever retina
			// size it was saved — and it is not ours to rewrite.
			const original = join(dir, "CleanShot 2026-08-03 at 20.27.12@2x.png");
			execFileSync("magick", ["-size", "3000x2000", "gradient:navy-white", original]);
			const before = statSync(original);

			const adopted = await adoptImageFile(original);

			expect(adopted).not.toBe(original);
			expect(basename(adopted)).toStartWith("pi-clipboard-");
			expect(getImageDimensions(readFileSync(adopted).toString("base64"), "image/png")).toMatchObject({
				widthPx: 2000,
			});
			expect(statSync(original)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs });
			rmSync(adopted, { force: true });
		});
	});

	test("keeps the original when it is already within the ceiling", async () => {
		await withImageDir(async (dir) => {
			const original = join(dir, "small.png");
			execFileSync("magick", ["-size", "860x556", "gradient:navy-white", original]);

			const adopted = await adoptImageFile(original);

			expect(getImageDimensions(readFileSync(adopted).toString("base64"), "image/png")).toMatchObject({
				widthPx: 860,
				heightPx: 556,
			});
			rmSync(adopted, { force: true });
		});
	});

	test("leaves an already-tight image byte-for-byte alone", async () => {
		await withImageDir(async (dir) => {
			const path = join(dir, "tight.png");
			execFileSync("magick", [
				"-size",
				"800x600",
				"xc:white",
				"-fill",
				"#24292f",
				"-draw",
				"circle 400,300 400,80",
				path,
			]);

			const image = await createReadImageLoader()(path, {} as never);

			expect(image?.data).toBe(readFileSync(path).toString("base64"));
		});
	});
});

describe("handle thumbnails", () => {
	test("refuses a raster short of a full row", () => {
		expect(pickCellColors(Buffer.alloc(11), 2, 2)).toBeUndefined();
	});
});

describe("handles", () => {
	test("resolves each handle once, ignoring unknown numbers", () => {
		const handles = new Map([
			[1, "/tmp/one.png"],
			[2, "/tmp/two.png"],
		]);
		expect(resolveImageHandles("[image #2] vs [image #1] vs [image #2] vs [image #9]", handles)).toEqual([
			{ handle: "[image #2]", path: "/tmp/two.png" },
			{ handle: "[image #1]", path: "/tmp/one.png" },
		]);
	});

	test("names the file behind each handle so the model can reread it", () => {
		expect(appendHandlePaths("what is this?", [{ handle: "[image #1]", path: "/tmp/one.png" }])).toBe(
			"what is this?\n\n[image #1] /tmp/one.png",
		);
	});

	test("leaves text untouched when there are no handles", () => {
		expect(appendHandlePaths("plain text", [])).toBe("plain text");
	});
});

describe("input hook", () => {
	test("transforms a user message into text plus native image content", async () => {
		await withImageDir(async (dir) => {
			const path = join(dir, "shot.png");
			await writeFile(path, Buffer.from(PNG_BASE64, "base64"));
			const { handle, sent } = inputHandler(async () => image());

			const result = await handle({ text: `review ${path}`, source: "interactive" }, { ...multimodal, cwd: dir });

			expect(result).toEqual({ action: "transform", text: `review ${path}`, images: [image()] });
			expect(sent).toEqual([
				{
					customType: "image-attach-preview",
					content: "",
					display: true,
					details: { paths: [path] },
				},
			]);
		});
	});

	test("leaves the message alone for a text-only model", async () => {
		await withImageDir(async (dir) => {
			const path = join(dir, "shot.png");
			await writeFile(path, Buffer.from(PNG_BASE64, "base64"));
			const { handle, sent } = inputHandler(async () => image());

			const result = await handle(
				{ text: `review ${path}`, source: "interactive" },
				{ cwd: dir, model: { input: ["text"] } },
			);

			expect(result).toEqual({ action: "continue" });
			expect(sent).toEqual([]);
		});
	});

	test("ignores extension-injected input so transforms cannot loop", async () => {
		const { handle } = inputHandler(async () => {
			throw new Error("should not load");
		});
		expect(await handle({ text: "/tmp/a.png", source: "extension" }, multimodal)).toEqual({ action: "continue" });
	});
});
