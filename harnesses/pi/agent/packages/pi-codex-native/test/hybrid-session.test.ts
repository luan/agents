import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import contextExtension from "../../pi-context-windows/src/extension.ts";
import { latestWindow } from "../../pi-context-windows/src/core/state.ts";
import { publishAllSettings } from "../../pi-xsettings/src/runtime/settings.ts";
import { ensureXSettingsRegistry } from "../../pi-xsettings/src/protocol/settings.ts";
import registerNativeCompaction from "../src/compaction/extension.ts";
import { getCodexModels } from "../src/provider/models.ts";
import { buildRequestBody } from "../src/provider/request-body.ts";
import type { OpenAICodexStreamOptions, ResponsesBody } from "../src/provider/types.ts";

const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.fixture`;

test.each([false, true])("native hybrid survives repeated rollover and resume (tree=%s)", async (tree) => {
	const root = await mkdtemp(join(tmpdir(), "pi-hybrid-"));
	const runtime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(root, "models.json"),
		refreshOnCreate: false,
	});
	const model = getCodexModels().find((model) => model.id === "gpt-5.6-luna");
	if (!model) throw new Error("Missing fixture model");
	let step = 0,
		compactions = 0;
	let rejectCheckpoint = false;
	const requests: ResponsesBody[] = [];
	const compactInputs: ResponsesBody[] = [];
	const streamSimple = (model: Model<Api>, context: Context, rawOptions?: SimpleStreamOptions) => {
		const stream = createAssistantMessageEventStream();
		// type-boundary: native compaction's provider stream options carry the validated native callbacks.
		const options = rawOptions as OpenAICodexStreamOptions | undefined;
		queueMicrotask(async () => {
			try {
				const body = buildRequestBody(model, context, options);
				const payload = ((await options?.onPayload?.(body, model)) as ResponsesBody | undefined) ?? body;
				const summary = JSON.stringify(context.messages).includes("<conversation>") && context.messages.length === 1;
				let content: AssistantMessage["content"] = [
					{ type: "text", text: summary ? "PORTABLE: remember the green widget" : "Finished" },
				];
				let stopReason: "stop" | "toolUse" = "stop";
				if (options?.canonicalCompaction) {
					compactInputs.push(structuredClone(payload));
					if (rejectCheckpoint) throw new Error("fixture checkpoint unavailable");
					compactions++;
					options.onOutputItemDone?.({ type: "compaction", encrypted_content: `encrypted-${compactions}` });
				} else if (!summary) {
					requests.push(structuredClone(payload));
					step++;
					if (step === 1 || step === 2 || step === 5) {
						content = [{ type: "toolCall", id: `rotate-${step}`, name: "new_context", arguments: {} }];
						stopReason = "toolUse";
					}
				}
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content,
					stopReason,
					responseId: `response-${step}-${compactions}`,
					usage: {
						input: 100,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 110,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				};
				stream.push({ type: "done", reason: stopReason, message });
				stream.end();
			} catch (error) {
				const failure: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [],
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				};
				stream.push({ type: "error", reason: "error", error: failure });
				stream.end();
			}
		});
		return stream;
	};
	runtime.registerNativeProvider({
		id: "openai-codex",
		name: "Fixture",
		baseUrl: model.baseUrl,
		auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: token } }) } },
		getModels: () => [model],
		stream: streamSimple,
		streamSimple,
	});
	const settingsManager = SettingsManager.inMemory({
		defaultProjectTrust: "always",
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	let session: AgentSession | undefined;
	const create = async (manager: SessionManager, reversed = false) => {
		const factories = [contextExtension, registerNativeCompaction];
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noContextFiles: true,
			noPromptTemplates: true,
			systemPrompt: "Finish the task.",
			extensionFactories: reversed ? factories.reverse() : factories,
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		const result = await createAgentSession({
			cwd: root,
			agentDir: root,
			modelRuntime: runtime,
			model,
			settingsManager,
			sessionManager: manager,
			resourceLoader: loader,
			tools: ["new_context"],
		});
		session = result.session;
		await session.bindExtensions({
			mode: "print",
			onError: (error) => {
				throw new Error(error.error);
			},
			commandContextActions: {
				waitForIdle: async () => {},
				newSession: async () => ({ cancelled: true }),
				fork: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				reload: async () => {},
				navigateTree: (id, options) => result.session.navigateTree(id, options),
			},
		});
		await session.prompt("/pi-context-capture");
		return result.session;
	};
	try {
		const manager = SessionManager.create(root, join(root, "sessions"));
		session = await create(manager);
		await publishAllSettings(ensureXSettingsRegistry(), {
			behavior: { "pi-context-windows": { hybrid: true, archiveMode: tree ? "tree" : "local" } },
		});
		await session.prompt("Remember the green widget; start two fresh windows.");
		await session.waitForIdle();
		expect(session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
		expect(compactions).toBe(2);
		expect(latestWindow(manager.getBranch())?.state.providerCheckpoint).toContain("encrypted-2");
		expect(latestWindow(manager.getBranch())?.state.summary).toContain("PORTABLE");
		expect(JSON.stringify(requests[1])).toContain("encrypted-1");
		expect(JSON.stringify(requests[2])).toContain("encrypted-2");
		expect(JSON.stringify(requests[2])).not.toContain("encrypted-1");
		expect(JSON.stringify(compactInputs[1])).toContain("encrypted-1");
		expect(
			requests[2].input.filter(
				(item) => typeof item === "object" && item !== null && "type" in item && item.type === "compaction",
			),
		).toHaveLength(1);
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing session file");
		await session.dispose();
		const resumed = SessionManager.open(file);
		session = await create(resumed, true);
		await session.prompt("Continue after resume");
		expect(JSON.stringify(requests.at(-1))).toContain("encrypted-2");
		// A failed checkpoint must preserve the current window and its recoverable history.
		rejectCheckpoint = true;
		const previous = latestWindow(resumed.getBranch())?.state.id;
		await session.prompt("Try another fresh window");
		await session.waitForIdle();
		expect(latestWindow(resumed.getBranch())?.state.id).toBe(previous);
		expect(latestWindow(resumed.getBranch())?.state.providerCheckpoint).toContain("encrypted-2");
	} finally {
		await session?.dispose();
		await publishAllSettings(ensureXSettingsRegistry(), {});
		await rm(root, { recursive: true, force: true });
	}
});
