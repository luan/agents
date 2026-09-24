import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import { describeImage } from "../src/runtime/describe-image.ts";

test("vision descriptions use an isolated image request and propagate provider failures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-vision-"));
	try {
		const runtime = await ModelRuntime.create({
			authPath: join(directory, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(directory, "models.json"),
			refreshOnCreate: false,
		});
		const registry = new ModelRegistry(runtime);
		let received: Context | undefined;
		let failed = false;
		registry.registerProvider("vision-test", {
			api: "openai-responses",
			apiKey: "fixture",
			baseUrl: "https://test.invalid",
			models: [
				{
					id: "vision",
					name: "Vision",
					input: ["text", "image"],
					reasoning: false,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10000,
					maxTokens: 1000,
				},
			],
			streamSimple(model, context, options) {
				received = context;
				expect(options?.sessionId).toBeUndefined();
				const stream = createAssistantMessageEventStream();
				const message = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "A red square." }],
					api: model.api,
					model: model.id,
					provider: model.provider,
					stopReason: failed ? ("error" as const) : ("stop" as const),
					errorMessage: failed ? "Vision unavailable" : undefined,
					timestamp: 1,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				queueMicrotask(() => {
					if (failed) stream.push({ type: "error", reason: "error", error: message });
					else stream.push({ type: "done", reason: "stop", message });
					stream.end();
				});
				return stream;
			},
		});
		const image = {
			data: "aW1hZ2U=",
			mimeType: "image/png",
			detail: "high" as const,
			path: "/image.png",
			width: 1,
			height: 1,
			bytes: 5,
		};
		expect(await describeImage(image, "vision-test/vision", { modelRegistry: registry })).toEqual({
			text: "A red square.",
			model: "vision-test/vision",
		});
		expect(received?.messages).toHaveLength(1);
		expect(JSON.stringify(received?.messages)).toContain('"type":"image"');
		failed = true;
		await expect(describeImage(image, "vision-test/vision", { modelRegistry: registry })).rejects.toThrow(
			"Vision unavailable",
		);
		await expect(describeImage(image, "missing/model", { modelRegistry: registry })).rejects.toThrow(
			"unavailable or lacks vision",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
