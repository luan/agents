import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getCapabilities, resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import piPrettyExtension from "./index";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

class TestText {
	private text: string;
	constructor(text = "") {
		this.text = text;
	}
	setText(next: string) {
		this.text = next;
	}
	getText() {
		return this.text;
	}
	render() {
		return this.text ? [this.text] : [];
	}
}

function createTools(
	overrides: {
		execute?: (...args: any[]) => Promise<any>;
		resizeImage?: (...args: any[]) => Promise<any>;
		formatDimensionNote?: (result: any) => string | undefined;
	} = {},
) {
	const tools: any[] = [];
	piPrettyExtension(
		{
			registerTool(tool: any) {
				tools.push(tool);
			},
			on() {},
		},
		{
			sdk: {
				createReadTool: () => ({
					name: "read",
					async execute(...args: any[]) {
						if (overrides.execute) return overrides.execute(...args);
						return { content: [{ type: "text", text: "file contents" }] };
					},
				}),
				resizeImage: overrides.resizeImage,
				formatDimensionNote: overrides.formatDimensionNote,
			},
			TextComponent: TestText,
		} as any,
	);
	return tools;
}

describe("pretty image rendering", () => {
	test("view_image delegates image reads and detaches renderable blocks", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pretty-view-image-"));
		setCapabilities({ ...getCapabilities(), images: "kitty" });
		try {
			const imagePath = join(dir, "pixel.png");
			await writeFile(imagePath, PNG_BYTES);
			let delegatedParams: any;
			const viewImage = createTools({
				async execute(_tid, params) {
					delegatedParams = params;
					return {
						content: [
							{ type: "text", text: "Read image file [image/png]" },
							{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
						],
					};
				},
			}).find((tool) => tool.name === "view_image");

			const result = await viewImage.execute(
				"tid",
				{ path: imagePath, offset: 10, limit: 5 },
				undefined,
				undefined,
				{},
			);

			expect(delegatedParams).toEqual({ path: imagePath });
			expect(result.content.some((content: any) => content.type === "image")).toBe(false);
		} finally {
			resetCapabilitiesCache();
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("the kitty preview detaches images from the tool result for protocol restore", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pretty-view-image-preview-"));
		setCapabilities({ ...getCapabilities(), images: "kitty" });
		try {
			const imagePath = join(dir, "pixel.png");
			await writeFile(imagePath, PNG_BYTES);
			const viewImage = createTools({
				async execute() {
					return {
						content: [
							{ type: "text", text: "Read image file [image/png]" },
							{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
						],
					};
				},
			}).find((tool) => tool.name === "view_image");

			const result = await viewImage.execute("tid-preview", { path: imagePath }, undefined, undefined, {});

			expect(result.content.some((content: any) => content.type === "image")).toBe(false);
		} finally {
			resetCapabilitiesCache();
			await rm(dir, { recursive: true, force: true });
		}
	});
	test("fidelity glance resizes before protocol detachment", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pretty-view-image-fidelity-"));
		setCapabilities({ ...getCapabilities(), images: "kitty" });
		try {
			const imagePath = join(dir, "pixel.png");
			await writeFile(imagePath, PNG_BYTES);
			const resizeCalls: any[] = [];
			const viewImage = createTools({
				async execute() {
					return {
						content: [
							{ type: "text", text: "Read image file [image/png]" },
							{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
						],
					};
				},
				async resizeImage(_bytes: Uint8Array, mimeType: string, options: any) {
					resizeCalls.push({ mimeType, options });
					return {
						data: "GLANCE",
						mimeType: "image/png",
						width: 720,
						height: 540,
						originalWidth: 2000,
						originalHeight: 1500,
						wasResized: true,
					};
				},
				formatDimensionNote: () => "[Image: original 2000x1500, displayed at 720x540.]",
			}).find((tool) => tool.name === "view_image");

			const glance = await viewImage.execute(
				"tid-glance",
				{ path: imagePath, fidelity: "glance" },
				undefined,
				undefined,
				{},
			);
			const readable = await viewImage.execute(
				"tid-readable",
				{ path: imagePath, fidelity: "readable" },
				undefined,
				undefined,
				{},
			);

			expect(resizeCalls).toEqual([{ mimeType: "image/png", options: { maxWidth: 720, maxHeight: 540 } }]);
			expect(glance.content.some((content: any) => content.type === "image")).toBe(false);
			expect(glance.content.some((content: any) => content.text?.includes("original 2000x1500"))).toBe(true);
			expect(readable.content.some((content: any) => content.type === "image")).toBe(false);
		} finally {
			resetCapabilitiesCache();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
