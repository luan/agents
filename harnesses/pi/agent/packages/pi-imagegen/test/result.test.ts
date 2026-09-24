import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imagegenResult } from "../src/tools/imagegen/definition.ts";

test("Code Mode receives the saved image even when the active model has text-only output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-imagegen-"));
	const path = join(directory, "image.png");
	const data = Buffer.from("iVBORw0KGgo=", "base64");
	try {
		await writeFile(path, data);
		const content = [{ type: "text" as const, text: `Generated image: ${path}` }];
		const expected = { image_url: `data:image/png;base64,${data.toString("base64")}`, output_hint: content[0]!.text };
		expect(imagegenResult({ content, details: { path, images: [{ absolute_path: path }] } })).toEqual(expected);
		expect(
			imagegenResult({
				content: [...content, { type: "image", data: data.toString("base64"), mimeType: "image/png" }],
				details: {},
			}),
		).toEqual(expected);
		await rm(path);
		expect(() => imagegenResult({ content, details: { path, images: [{ absolute_path: path }] } })).toThrow(
			"Generated image:",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
