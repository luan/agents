import { describe, expect, test } from "bun:test";

import { detachToolResultImages, registerToolResultImageRestore } from "./tool-result-images";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function image() {
	return { type: "image", data: PNG_BASE64, mimeType: "image/png" };
}

function contextHandler() {
	let handler: ((event: { messages: unknown[] }) => { messages: unknown[] }) | undefined;
	const pi = {
		on(event: string, next: never) {
			if (event === "context") handler = next as never;
		},
	};
	registerToolResultImageRestore(pi);
	if (!handler) throw new Error("context handler was not registered");
	return handler;
}

describe("tool result images", () => {
	test("detached images come back on the next request", () => {
		const result = { content: [{ type: "text", text: "Read image file [image/png]" }, image()] };
		detachToolResultImages("call-1", result);
		expect(result.content).toEqual([{ type: "text", text: "Read image file [image/png]" }]);

		const restored = contextHandler()({
			messages: [{ role: "toolResult", toolCallId: "call-1", content: result.content }],
		});
		expect(restored.messages).toEqual([
			{
				role: "toolResult",
				toolCallId: "call-1",
				content: [{ type: "text", text: "Read image file [image/png]" }, image()],
			},
		]);
	});

	test("messages without detached images pass through untouched", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "toolResult", toolCallId: "unknown-call", content: [{ type: "text", text: "ok" }] },
		];
		expect(contextHandler()({ messages })).toEqual({ messages });
	});

	test("an image already in content is not duplicated", () => {
		const result = { content: [image()] };
		detachToolResultImages("call-2", result);

		const restored = contextHandler()({
			messages: [{ role: "toolResult", toolCallId: "call-2", content: [image()] }],
		});
		expect(restored.messages).toEqual([{ role: "toolResult", toolCallId: "call-2", content: [image()] }]);
	});
});
