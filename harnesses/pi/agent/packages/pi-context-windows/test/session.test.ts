import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type Context, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { pendingQuestions } from "../../pi-conversation/src/core/state.ts";
import conversationExtension from "../../pi-conversation/src/extension.ts";
import { publishAllSettings } from "../../pi-xsettings/src/runtime/settings.ts";
import { ensureXSettingsRegistry } from "../../pi-xsettings/src/protocol/settings.ts";
import { archivedHistory } from "../src/core/archives.ts";
import { historyItems } from "../src/core/history.ts";
import { initialWindowId, latestWindow, readNotes } from "../src/core/state.ts";
import contextExtension from "../src/extension.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

test.each([
	{ overflow: false, tree: false, hybrid: false },
	{ overflow: true, tree: false, hybrid: true },
	{ overflow: false, tree: true, hybrid: true },
])("real Pi session recovers notes, questions, summaries and history (%j)", async ({ overflow, tree, hybrid }) => {
	const root = await mkdtemp(join(tmpdir(), "pi-context-test-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models.json"),
		refreshOnCreate: false,
	});
	let step = 0;
	const requests: Context[] = [];
	runtime.registerProvider("context-test", {
		baseUrl: "https://test.invalid",
		apiKey: "fixture",
		api: "openai-responses",
		models: [
			{
				id: "fixture",
				name: "Fixture",
				reasoning: false,
				input: ["text"],
				cost,
				contextWindow: 10000,
				maxTokens: 1000,
			},
		],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (context.messages.length === 1 && JSON.stringify(context.messages[0]).includes("<conversation>")) {
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "GENERATED-CHECKPOINT: validate the widget; expected color green" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { ...cost, total: 0 } },
						stopReason: "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "done", reason: "stop", message });
					stream.end();
					return;
				}
				requests.push({ ...context, messages: structuredClone(context.messages) });
				step++;
				let content: AssistantMessage["content"];
				let stopReason: AssistantMessage["stopReason"] = "toolUse";
				if (step === 1)
					content = [
						{
							type: "toolCall",
							id: "note",
							name: "notes__write_file",
							arguments: { path: "checkpoint", text: "CHECKPOINT: validate the widget; expected color green" },
						},
						{ type: "toolCall", id: "rotate", name: "new_context", arguments: {} },
						{
							type: "toolCall",
							id: "question",
							name: "request_user_input_async",
							arguments: { questions: [{ title: "Which color?", options: ["Green", "Blue"] }] },
						},
					];
				else if (step === 2)
					content = [
						{
							type: "toolCall",
							id: "history",
							name: "history__search_contents",
							arguments: { query: "OLD-DETAIL", role: "assistant" },
						},
						{ type: "toolCall", id: "read-note", name: "notes__read_file", arguments: { path: "checkpoint" } },
						{ type: "toolCall", id: "time", name: "clock__curr_time", arguments: {} },
					];
				else {
					content = [{ type: "text", text: "Done" }];
					stopReason = "stop";
				}
				const error = overflow && step === 3;
				const message: AssistantMessage = {
					role: "assistant",
					content: error ? [] : content,
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { input: 150, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 170, cost: { ...cost, total: 0 } },
					stopReason: error ? "error" : stopReason,
					...(error ? { errorMessage: "maximum context length exceeded" } : {}),
					timestamp: Date.now(),
				};
				if (error) stream.push({ type: "error", reason: "error", error: message });
				else stream.push({ type: "done", reason: stopReason as "stop" | "toolUse", message });
				stream.end();
			});
			return stream;
		},
	});
	const settings = SettingsManager.inMemory({
		compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 },
		retry: { enabled: false },
		defaultProjectTrust: "always",
	});
	const create = async (
		manager: SessionManager,
		factories: ExtensionFactory[] = [contextExtension, conversationExtension],
	) => {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Finish the user's task.",
			extensionFactories: factories,
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		return (
			await createAgentSession({
				cwd: root,
				agentDir,
				modelRuntime: runtime,
				model: runtime.getModel("context-test", "fixture"),
				settingsManager: settings,
				sessionManager: manager,
				resourceLoader: loader,
				tools: [
					"notes__write_file",
					"notes__read_file",
					"history__search_contents",
					"new_context",
					"request_user_input_async",
					"clock__curr_time",
				],
			})
		).session;
	};
	const manager = SessionManager.create(root, join(root, "sessions"));
	let session = await create(manager);
	await publishAllSettings(ensureXSettingsRegistry(), {
		behavior: { "pi-context-windows": { hybrid, archiveMode: tree ? "tree" : "local" } },
	});
	const bind = async () => {
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
				navigateTree: (id, options) => session.navigateTree(id, options),
			},
		});
		await session.prompt("/pi-context-capture");
	};
	await bind();
	try {
		manager.appendMessage({ role: "user", content: "Earlier request", timestamp: 1 });
		const model = runtime.getModel("context-test", "fixture");
		if (!model) throw new Error("Missing fixture model");
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `OLD-DETAIL ${"prior evidence ".repeat(1000)}` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } },
			stopReason: "stop",
			timestamp: 2,
		});
		await session.prompt("Validate the widget and use a fresh context.");
		await session.waitForIdle();
		expect(session.messages.at(-1)?.role).toBe("assistant");
		expect(session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
		expect(step).toBe(overflow ? 4 : 3);
		expect(JSON.stringify(requests[1].messages)).not.toContain("OLD-DETAIL");
		expect(JSON.stringify(requests[1].messages)).toContain("CHECKPOINT");
		expect(JSON.stringify(requests[2].messages)).toContain("OLD-DETAIL");
		const timeResult = requests[2].messages.find(
			(message) => message.role === "toolResult" && message.toolName === "clock__curr_time",
		);
		const savedTime = manager
			.getBranch()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "clock__curr_time",
			);
		if (savedTime?.type !== "message" || savedTime.message.role !== "toolResult")
			throw new Error("Clock result not persisted");
		expect(timeResult?.content).toEqual(savedTime.message.content);
		expect(timeResult?.content).toHaveLength(1);
		if (timeResult?.role !== "toolResult" || timeResult.content[0]?.type !== "text")
			throw new Error("Clock result missing");
		expect(JSON.parse(timeResult.content[0].text)).toEqual({ current_time: expect.any(String) });
		expect(
			archivedHistory(manager.getEntries(), manager.getBranch())
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolName === "request_user_input_async",
				)
				.map((entry) => (entry.type === "message" ? entry.message : null)),
		).toMatchObject([{ isError: false }]);
		expect(pendingQuestions(manager.getBranch())).toHaveLength(1);
		expect(readNotes(manager.getBranch()).get("checkpoint")?.text).toContain("green");
		const items = historyItems(archivedHistory(manager.getEntries(), manager.getBranch()), manager.getSessionId());
		expect(items.some((item) => item.content.includes("OLD-DETAIL"))).toBe(true);
		expect(latestWindow(manager.getBranch())).toBeDefined();
		if (hybrid) expect(latestWindow(manager.getBranch())?.state.summary).toContain("GENERATED-CHECKPOINT");
		if (tree)
			expect(
				manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "pi-context/archive/v1"),
			).toBe(true);
		expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(overflow ? 1 : 0);
		const file = manager.getSessionFile();
		if (!file) throw new Error("Session not persisted");
		const origin = initialWindowId(manager.getSessionId(), manager.getBranch());
		await session.dispose();
		const resumed = SessionManager.open(file);
		session = await create(resumed, [conversationExtension, contextExtension]);
		await bind();
		await session.prompt("Continue after resume");
		expect(session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
		expect(pendingQuestions(resumed.getBranch())).toHaveLength(1);
		expect(initialWindowId("fork-id", resumed.getBranch())).toBe(origin);
		expect(JSON.stringify(requests.at(-1)?.messages)).toContain("CHECKPOINT");
	} finally {
		await session.dispose();
		await publishAllSettings(ensureXSettingsRegistry(), {});
		await rm(root, { recursive: true, force: true });
	}
});
