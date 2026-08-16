import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import imageAttachExtension, {
	appendHandlePaths,
	collectImageAttachments,
	findImagePathTokens,
	imageIdentity,
	pastedImagePath,
	resolveImageHandles,
} from "./index";

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

function inputHandler(loadImage?: (path: string) => Promise<ReturnType<typeof image> | undefined>, cwd = "/repo") {
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
		loadImage ? { loadImage: (path) => loadImage(path) } : undefined,
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

	test("identity ignores what this extension re-encodes", () => {
		expect(imageIdentity(image())).toBe(imageIdentity(image()));
		expect(imageIdentity(image())).not.toBe(imageIdentity(image(`${PNG_BASE64}x`)));
	});

	test("ignores extension-injected input so transforms cannot loop", async () => {
		const { handle } = inputHandler(async () => {
			throw new Error("should not load");
		});
		expect(await handle({ text: "/tmp/a.png", source: "extension" }, multimodal)).toEqual({ action: "continue" });
	});
});
