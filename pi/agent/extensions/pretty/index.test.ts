import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCapabilities } from "@earendil-works/pi-tui";

import piPrettyExtension from "./index";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

function createText() {
	let value = "";
	return {
		setText(next: string) {
			value = next;
		},
		getText() {
			return value;
		},
	};
}

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

const theme = {
	fg(_role: string, text: string) {
		return text;
	},
	bold(text: string) {
		return `**${text}**`;
	},
};

function createTools(overrides: { execute?: (...args: any[]) => Promise<any> } = {}) {
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
			},
			TextComponent: TestText,
		} as any,
	);
	return tools;
}

describe("pretty read rendering", () => {
	test("read calls render as compact exploration with a capitalized title", () => {
		const read = createTools().find((tool) => tool.name === "read");
		const text = createText();

		read.renderCall({ path: "/tmp/example.ts" }, theme, {
			lastComponent: text,
			isPartial: false,
			isError: false,
			invalidate() {},
		});

		expect(text.getText()).toContain("• **Explored**");
		expect(text.getText()).toContain("└ Read /tmp/example.ts all lines");
	});

	test("read calls include requested line ranges", () => {
		const read = createTools().find((tool) => tool.name === "read");
		const text = createText();

		read.renderCall({ path: "/tmp/example.ts", offset: 12, limit: 8 }, theme, {
			lastComponent: text,
			isPartial: false,
			isError: false,
			invalidate() {},
		});

		expect(text.getText()).toContain("└ Read /tmp/example.ts lines 12-19");
	});

	test("read calls under the working directory render as relative paths", () => {
		const read = createTools().find((tool) => tool.name === "read");
		const text = createText();
		const path = `${process.cwd()}/crates/ct/src/apply_patch/draft_store.rs`;

		read.renderCall({ path, offset: 1440, limit: 90 }, theme, {
			lastComponent: text,
			isPartial: false,
			isError: false,
			invalidate() {},
		});

		expect(text.getText()).toContain("└ Read crates/ct/src/apply_patch/draft_store.rs lines 1440-1529");
	});

	test("relative read paths are resolved before display", () => {
		const read = createTools().find((tool) => tool.name === "read");
		const text = createText();

		read.renderCall({ path: "./crates/ct/../ct/src/apply_patch/draft_store.rs" }, theme, {
			lastComponent: text,
			isPartial: false,
			isError: false,
			invalidate() {},
		});

		expect(text.getText()).toContain("└ Read crates/ct/src/apply_patch/draft_store.rs all lines");
	});

	test("read results stay collapsed even when expanded", () => {
		const read = createTools().find((tool) => tool.name === "read");
		const text = createText();

		read.renderResult(
			{ content: [{ type: "text", text: "file contents" }] },
			{ expanded: true, isPartial: false },
			theme,
			{ lastComponent: text, isError: false, invalidate() {} },
		);

		expect(text.getText()).toBe("");
	});

	test("read rejects image files instead of returning image content", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pretty-read-"));
		try {
			const imagePath = join(dir, "pixel.png");
			await writeFile(imagePath, PNG_BYTES);
			let delegated = false;
			const read = createTools({
				async execute() {
					delegated = true;
					return { content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }] };
				},
			}).find((tool) => tool.name === "read");

			await expect(read.execute("tid", { path: imagePath }, undefined, undefined, {})).rejects.toThrow(
				"read only supports text files",
			);
			expect(delegated).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("view_image delegates image reads without offset or limit", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pretty-view-image-"));
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
			expect(result.content.some((content: any) => content.type === "image")).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("view_image renders an inline preview even when showImages is disabled", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			const viewImage = createTools().find((tool) => tool.name === "view_image");
			const component = viewImage.renderResult(
				{
					content: [
						{ type: "text", text: "Read image file [image/png]" },
						{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
					],
				},
				{ expanded: false, isPartial: false },
				theme,
				{ state: {}, expanded: false, showImages: false, isError: false, invalidate() {} },
			);

			const rendered = component.render(80).join("\n");
			expect(rendered).toContain("\x1b]1337;File=");
			expect(rendered).not.toContain("Read image file");
		} finally {
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		}
	});

	test("view_image call renders as a viewed-image header with dim path", () => {
		const viewImage = createTools().find((tool) => tool.name === "view_image");
		const text = createText();
		const path = "/tmp/pixel.png";

		viewImage.renderCall({ path }, theme, {
			lastComponent: text,
			isPartial: false,
			isError: false,
			invalidate() {},
		});

		expect(text.getText()).toBe("**Viewed image** ─ /tmp/pixel.png");
	});
});
