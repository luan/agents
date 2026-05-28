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

describe("pretty image rendering", () => {
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
