import { expect, test } from "bun:test";
import { parseReply } from "../src/runtime/client.ts";
import { notebookResult } from "../src/tools/definition.ts";

test("notebook protocol validates replies and preserves execution failure details", () => {
	expect(parseReply('{"version":1,"ok":true,"result":{"output":[{"type":"error","text":"cell failed"}]}}')).toEqual({
		output: [{ type: "error", text: "cell failed" }],
	});
	for (const reply of [
		"null",
		"[]",
		'{"version":2,"ok":true,"result":{}}',
		'{"version":1,"ok":true}',
		'{"version":1,"ok":false,"error":"checkpoint lost"}',
	])
		expect(() => parseReply(reply)).toThrow();
});

test("notebook Code Mode exposes image output separately from text", () => {
	const result = notebookResult({
		content: [
			{ type: "text", text: "chart" },
			{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
		],
		details: { version: 1, tool: "notebook", status: "succeeded", text: "chart" },
	});
	expect(result).toEqual({ text: "chart", images: ["data:image/png;base64,aW1hZ2U="] });
});
