import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAutoReasoning } from "../src/tools/change-reasoning/definition.ts";
import { registerCodexNativeXSettings } from "../src/contributions/xsettings.ts";
import { publishAllSettings } from "../../pi-xsettings/src/runtime/settings.ts";
import { ensureXSettingsRegistry } from "../../pi-xsettings/src/protocol/settings.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
test.each([false, true])("Astra effort respects the floor and later user choices (manual=%s)", async (manual) => {
	const root = await mkdtemp(join(tmpdir(), "pi-effort-"));
	const runtime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(root, "models.json"),
		refreshOnCreate: false,
	});
	let session: AgentSession | undefined;
	let step = 0;
	const observed: string[] = [];
	const disposeSettings = registerCodexNativeXSettings();
	runtime.registerProvider("openai-codex", {
		baseUrl: "https://test.invalid",
		apiKey: "fixture",
		api: "openai-codex-responses",
		models: [
			{
				id: "gpt-6-astra",
				name: "Fixture Astra",
				reasoning: true,
				input: ["text"],
				cost,
				contextWindow: 100000,
				maxTokens: 1000,
			},
		],
		streamSimple(model) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				step++;
				observed.push(session?.thinkingLevel ?? "missing");
				if (step === 2 && manual) session?.setThinkingLevel("low");
				const stopReason = step <= 2 ? "toolUse" : "stop";
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content:
						step <= 2
							? [
									{
										type: "toolCall",
										id: `effort-${step}`,
										name: "change_reasoning",
										arguments: { level: step === 1 ? "high" : "low" },
									},
								]
							: [{ type: "text", text: "Finished" }],
					stopReason,
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } },
					timestamp: Date.now(),
				};
				stream.push({ type: "done", reason: stopReason, message });
				stream.end();
			});
			return stream;
		},
	});
	const settingsManager = SettingsManager.inMemory({
		defaultProjectTrust: "always",
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noContextFiles: true,
		noPromptTemplates: true,
		extensionFactories: [
			(pi) => {
				registerAutoReasoning(pi);
			},
		],
	});
	try {
		await publishAllSettings(ensureXSettingsRegistry(), { tools: { "pi-codex-native": { autoReasoning: true } } });
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			modelRuntime: runtime,
			model: runtime.getModel("openai-codex", "gpt-6-astra"),
			thinkingLevel: "medium",
			settingsManager,
			sessionManager: SessionManager.inMemory(root),
			resourceLoader: loader,
			tools: ["change_reasoning"],
		}));
		await session.prompt("Use high effort, then request low effort, and finish.");
		expect(observed).toEqual(["medium", "high", manual ? "low" : "medium"]);
		expect(session.thinkingLevel).toBe(manual ? "low" : "medium");
		expect(session.messages.filter((message) => message.role === "toolResult")).toMatchObject([
			{ isError: false },
			{ isError: false },
		]);
		await publishAllSettings(ensureXSettingsRegistry(), {});
		await session.prompt("Continue with auto reasoning disabled.");
		expect(session.getActiveToolNames()).not.toContain("change_reasoning");
	} finally {
		await session?.dispose();
		await publishAllSettings(ensureXSettingsRegistry(), {});
		disposeSettings();
		await rm(root, { recursive: true, force: true });
	}
});
