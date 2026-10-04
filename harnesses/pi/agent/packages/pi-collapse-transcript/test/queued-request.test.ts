import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createReadToolDefinition,
	DefaultResourceLoader,
	initTheme,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, ProcessTerminal, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import transcriptExtension from "../src/extension.ts";

class TestTui extends TuiAltScreen {
	requestRender(): void {}
}

test.each(["followUp", "steer"] as const)(
	"%s keeps requests compact and live without agent settlement",
	async (queue) => {
		initTheme("dark", false);
		const root = await mkdtemp(join(tmpdir(), "pi-queued-transcript-"));
		const tui = new TestTui(new ProcessTerminal());
		const document = new Container();
		const chat = new Container();
		document.addChild(new Container());
		document.addChild(new Container());
		document.addChild(chat);
		tui.addChild(document);
		const rendered = () => Bun.stripANSI(document.render(100).join("\n"));
		const append = (id: string, text: string) => {
			const tool = new ToolExecutionComponent("read", id, {}, {}, undefined, tui, root);
			tool.updateResult({ content: [{ type: "text", text }], isError: false });
			chat.addChild(tool);
		};
		const runtime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(root, "models.json"),
			refreshOnCreate: false,
		});
		const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		let session: AgentSession;
		let step = 0;
		const observations: string[] = [];
		runtime.registerProvider("queued-transcript", {
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
			streamSimple(model) {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(async () => {
					const first = step++ === 0;
					if (first) {
						append("first", "FIRST REQUEST OUTPUT");
						observations.push(rendered());
						await session[queue]("Second request");
					} else {
						append("second", "SECOND REQUEST OUTPUT");
						observations.push(rendered());
					}
					const stopReason = first && queue === "steer" ? "toolUse" : "stop";
					const message: AssistantMessage = {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						content:
							stopReason === "toolUse"
								? [{ type: "toolCall", id: "fixture-call", name: "fixture", arguments: { path: "example" } }]
								: [{ type: "text", text: "Answered" }],
						stopReason,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } },
						timestamp: 0,
					};
					stream.push({ type: "done", reason: stopReason, message });
					stream.end();
				});
				return stream;
			},
		});
		const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noContextFiles: true,
			noPromptTemplates: true,
			extensionFactories: [
				transcriptExtension,
				(pi) => {
					pi.on("message_start", (event) => {
						if (event.message.role === "user") chat.addChild(new Text("User request", 0, 0));
					});
					pi.registerTool({
						name: "fixture",
						label: "Fixture",
						description: "Queue boundary fixture",
						parameters: createReadToolDefinition(root).parameters,
						execute: async () => ({ content: [{ type: "text", text: "Completed step" }], details: {} }),
					});
				},
			],
		});
		await loader.reload();
		({ session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			modelRuntime: runtime,
			settingsManager: settings,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			model: runtime.getModel("queued-transcript", "fixture"),
		}));
		try {
			await session.bindExtensions({
				mode: "tui",
				uiContext: {
					...session.extensionRunner.getUIContext(),
					setWidget(_key, content) {
						if (typeof content === "function") content(tui, theme);
					},
				},
			});
			await session.prompt("First request");
			expect(observations).toHaveLength(2);
			for (const observation of observations) {
				expect(observation).toContain("Working · read · 1 step");
				expect(observation).not.toContain("FIRST REQUEST OUTPUT");
				expect(observation).not.toContain("SECOND REQUEST OUTPUT");
			}
			expect(observations[1]).toContain("Worked · read · 1 step");
			expect(rendered()).not.toContain("Working");
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			await rm(root, { recursive: true, force: true });
		}
	},
);
