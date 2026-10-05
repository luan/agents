import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	DefaultResourceLoader,
	InteractiveMode,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, type TUI } from "@earendil-works/pi-tui";
import transcriptExtension from "../src/extension.ts";

class CapturedTerminal extends ProcessTerminal {
	private input: ((data: string) => void) | undefined;
	get columns() {
		return 120;
	}
	get rows() {
		return 60;
	}
	start(onInput: (data: string) => void): void {
		this.input = onInput;
	}
	stop(): void {
		this.input = undefined;
	}
	write(data: string): void {
		// Answer the color-query sentinel immediately; tests never wait for a terminal timeout.
		if (data.includes("\x1b[c")) queueMicrotask(() => this.input?.("\x1b[?1;2c"));
	}
}

test.each(["manual", "boundary"] as const)(
	"%s compaction keeps display history while shrinking model context, including after resume",
	async (kind) => {
		const root = await mkdtemp(join(tmpdir(), "pi-compaction-transcript-"));
		let captured: TUI | undefined;
		const rendered = () => Bun.stripANSI(captured?.children[0]?.render(120).join("\n") ?? "");
		const manager = SessionManager.create(root, join(root, "sessions"));
		const oldId = manager.appendMessage({ role: "user", content: "EARLIER USER REQUEST", timestamp: 0 });
		const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const answer: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "transcript-fixture",
			model: "fixture",
			content: [{ type: "text", text: "LATEST ANSWER" }],
			stopReason: "stop",
			timestamp: 0,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost },
		};
		manager.appendMessage({ ...answer, content: [{ type: "text", text: "EARLIER ANSWER" }] });
		const keepId = manager.appendMessage({ role: "user", content: "RECENT USER REQUEST", timestamp: 1 });
		manager.appendMessage(answer);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(root, "models.json"),
			refreshOnCreate: false,
		});
		modelRuntime.registerProvider("transcript-fixture", {
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
					contextWindow: 1_000_000,
					maxTokens: 1000,
				},
			],
			streamSimple() {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: answer });
					stream.end();
				});
				return stream;
			},
		});
		const settingsManager = SettingsManager.inMemory({
			quietStartup: true,
			showCacheMissNotices: false,
			compaction: { enabled: false, keepRecentTokens: 1 },
			retry: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noContextFiles: true,
			noPromptTemplates: true,
			extensionFactories: [
				transcriptExtension,
				(pi) => {
					pi.on("session_start", (_event, ctx) =>
						ctx.ui.setWidget("capture", (tui) => {
							captured = tui;
							return { render: () => [], invalidate() {} };
						}),
					);
					pi.on("session_before_compact", () => ({
						compaction: { summary: "SAVED SUMMARY", firstKeptEntryId: keepId, tokensBefore: 257_174 },
					}));
					if (kind === "boundary")
						pi.on("turn_end", () => ({
							entries: [
								{ type: "compaction", summary: "SAVED SUMMARY", firstKeptEntryId: null },
								{ type: "custom_message", customType: "fixture", content: "AFTER BOUNDARY", display: true },
							],
						}));
				},
			],
		});
		await resourceLoader.reload();
		const services = { cwd: root, agentDir: root, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
		const start = async () => {
			const runtime = await createAgentSessionRuntime(
				async ({ sessionManager }) => ({
					...(await createAgentSessionFromServices({
						services,
						sessionManager,
						model: modelRuntime.getModel("transcript-fixture", "fixture"),
					})),
					services,
					diagnostics: [],
				}),
				{ cwd: root, agentDir: root, sessionManager: manager },
			);
			const mode = new InteractiveMode(runtime, {
				terminal: new CapturedTerminal(),
				tuiMode: "fullscreen",
				initialThemeSetting: "dark",
			});
			await mode.init();
			return { runtime, mode };
		};
		let current: Awaited<ReturnType<typeof start>> | undefined;
		try {
			current = await start();
			expect(rendered()).toContain("EARLIER USER REQUEST");
			if (kind === "manual") await current.runtime.session.compact();
			else await current.runtime.session.prompt("BOUNDARY REQUEST");
			const text = rendered();
			expect(text).toContain("EARLIER USER REQUEST");
			expect(text).toContain("EARLIER ANSWER");
			expect(text).toContain("RECENT USER REQUEST");
			expect(text).toContain("LATEST ANSWER");
			expect(text.match(/Context compacted/gu)).toHaveLength(1);
			expect(text).not.toContain("SAVED SUMMARY");
			if (kind === "boundary") expect(text).toContain("AFTER BOUNDARY");
			expect(manager.buildContextEntries().some((entry) => entry.id === oldId)).toBe(false);
			expect(manager.getBranch().some((entry) => entry.id === oldId)).toBe(true);
			expect(manager.buildSessionContext().messages.some((message) => message.role === "compactionSummary")).toBe(true);
			current.mode.stop();
			await current.runtime.dispose();
			current = undefined;
			// Reopen the same saved branch through a new native interactive mode.
			current = await start();
			expect(rendered()).toContain("EARLIER USER REQUEST");
			expect(rendered()).toContain("EARLIER ANSWER");
			expect(rendered().match(/Context compacted/gu)).toHaveLength(1);
			expect(rendered()).not.toContain("SAVED SUMMARY");
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a saved session");
			await current.runtime.newSession();
			expect(rendered()).not.toContain("EARLIER USER REQUEST");
			await current.runtime.switchSession(sessionFile);
			expect(rendered()).toContain("EARLIER USER REQUEST");
			expect(rendered().match(/Context compacted/gu)).toHaveLength(1);
		} finally {
			current?.mode.stop();
			await current?.runtime.dispose();
			await rm(root, { recursive: true, force: true });
		}
	},
);
