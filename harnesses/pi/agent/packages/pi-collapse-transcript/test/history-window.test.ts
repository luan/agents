import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	DefaultResourceLoader,
	InteractiveMode,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type Component, ProcessTerminal, type TuiAltScreen } from "@earendil-works/pi-tui";
import transcriptExtension from "../src/extension.ts";

const COLUMNS = 100;
const ROWS = 40;
const EPOCHS = 12;
const STEPS = 24;

class CapturedTerminal extends ProcessTerminal {
	private input: ((data: string) => void) | undefined;
	constructor(private readonly height: number) {
		super();
	}
	get columns() {
		return COLUMNS;
	}
	get rows() {
		return this.height;
	}
	start(onInput: (data: string) => void): void {
		this.input = onInput;
	}
	stop(): void {
		this.input = undefined;
	}
	write(data: string): void {
		if (data.includes("\x1b[c")) queueMicrotask(() => this.input?.("\x1b[?1;2c"));
	}
}

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "history-fixture",
		model: "fixture",
		content,
		stopReason,
		timestamp: 0,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost },
	};
}

/**
 * Each epoch is an autonomous turn: one request, many tool steps folded by the transcript, prose every
 * fourth step, and a final answer taller than the viewport. Pages hold a few steps, not whole epochs.
 */
function seed(manager: SessionManager, epochs = EPOCHS, steps = STEPS): void {
	for (let epoch = 0; epoch <= epochs; epoch++) {
		if (epoch > 0) manager.appendCompaction(`SUMMARY ${epoch}`, null, 1_000 * epoch);
		manager.appendMessage({ role: "user", content: `REQUEST ${epoch}`, timestamp: epoch });
		for (let step = 0; step < steps; step++) {
			const id = `call-${epoch}-${step}`;
			const lead =
				step % 4 === 3
					? { type: "text" as const, text: `PROSE ${epoch}.${step}` }
					: { type: "thinking" as const, thinking: `thinking ${epoch}.${step}` };
			manager.appendMessage(
				assistant([lead, { type: "toolCall", id, name: "read", arguments: { path: `f-${epoch}-${step}.ts` } }]),
			);
			manager.appendMessage({
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: `result ${epoch}.${step}` }],
				isError: false,
				timestamp: epoch,
			});
		}
		const lines = Array.from({ length: 30 }, (_, line) => `epoch ${epoch} line ${line}`);
		manager.appendMessage(assistant([{ type: "text", text: `ANSWER ${epoch}\n\n${lines.join("\n\n")}` }], "stop"));
	}
}

async function open(root: string, manager: SessionManager, rows = ROWS) {
	let captured: TuiAltScreen | undefined;
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(root, "models.json"),
		refreshOnCreate: false,
	});
	const settingsManager = SettingsManager.inMemory({
		quietStartup: true,
		showCacheMissNotices: false,
		compaction: { enabled: false },
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
						captured = tui as TuiAltScreen;
						return { render: () => [], invalidate() {} };
					}),
				);
			},
		],
	});
	await resourceLoader.reload();
	const services = { cwd: root, agentDir: root, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
	const runtime = await createAgentSessionRuntime(
		async ({ sessionManager }) => ({
			...(await createAgentSessionFromServices({ services, sessionManager })),
			services,
			diagnostics: [],
		}),
		{ cwd: root, agentDir: root, sessionManager: manager },
	);
	const mode = new InteractiveMode(runtime, {
		terminal: new CapturedTerminal(rows),
		tuiMode: "fullscreen",
		initialThemeSetting: "dark",
	});
	await mode.init();
	if (!captured) throw new Error("Expected the fullscreen TUI");
	const tui = captured;
	const chat: { children: Component[] } = Reflect.get(mode, "chatContainer");
	const frame = () => tui.renderNow();
	/** Every transcript line that is currently loaded. */
	const loaded = () => Bun.stripANSI(tui.children[0]?.render(COLUMNS).join("\n") ?? "");
	/** The rows painted in the terminal. */
	const screen = (): string[] => {
		const layout: { lines?: string[] } | undefined = Reflect.get(tui, "currentLayout");
		return (layout?.lines ?? []).map((line) => Bun.stripANSI(line).trimEnd());
	};
	/** Loaded history pages, each starting at a zero-height sentinel in Pi's chat container. */
	const pages = () => chat.children.filter((child) => child.constructor.name === "PageStart").length;
	/** The first loaded history component; it changes when an earlier page loads. */
	const head = () => chat.children[chat.children.findIndex((child) => child.constructor.name === "PageStart") + 1];
	return { runtime, mode, tui, chat, frame, loaded, screen, pages, head };
}

async function withSession(
	seedSession: (manager: SessionManager) => void,
	run: (session: Awaited<ReturnType<typeof open>>) => void | Promise<void>,
	rows = ROWS,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-history-window-"));
	const manager = SessionManager.create(root, join(root, "sessions"));
	seedSession(manager);
	const session = await open(root, manager, rows);
	try {
		await run(session);
	} finally {
		session.mode.stop();
		await session.runtime.dispose();
		await rm(root, { recursive: true, force: true });
	}
}

const requestsIn = (text: string) => (text.match(/^\s*REQUEST \d+/gmu) ?? []).length;

test("fullscreen history loads small pages around the viewport instead of whole compaction epochs", async () => {
	await withSession(seed, ({ tui, frame, loaded, screen, head, mode }) => {
		frame();
		frame();
		// The live context and a few pages of the newest saved epoch are loaded; older epochs are not.
		let text = loaded();
		expect(text).toContain(`ANSWER ${EPOCHS}`);
		expect(text).toContain(`ANSWER ${EPOCHS - 1}`);
		expect(text).not.toContain(`REQUEST ${EPOCHS - 3}`);
		expect(text).not.toContain(`ANSWER ${EPOCHS - 4}`);
		expect(text).toMatch(/▲ Earlier history · \d+ context windows · scroll up to load/u);
		expect(text).not.toContain("▼");

		// Reaching the top loads one earlier page and keeps the visible rows in place.
		const pendingTools: object = Reflect.get(mode, "pendingTools");
		const before = head();
		tui.scrollToTop();
		frame();
		// Compare rows without the scrollbar column, whose thumb moves when content loads above.
		const rows = () =>
			screen()
				.slice(3, 15)
				.map((line) => line.slice(0, COLUMNS - 2));
		const visible = rows();
		frame();
		expect(head()).not.toBe(before);
		expect(rows()).toEqual(visible);
		// Rendering a page through Pi's renderer leaves live tool tracking alone.
		expect(Reflect.get(mode, "pendingTools")).toBe(pendingTools);

		// Keep reading upwards until the first saved epoch is on screen.
		for (let step = 0; step < 40 * EPOCHS && !screen().some((line) => line.includes("REQUEST 0")); step++) {
			tui.scrollToTop();
			frame();
			frame();
		}
		expect(screen().some((line) => line.includes("REQUEST 0"))).toBe(true);
		text = loaded();
		expect(text).not.toContain("▲");
		// Pages far below the reader were released, leaving a marker for them.
		expect(text).not.toContain(`ANSWER ${EPOCHS - 1}`);
		expect(text).toMatch(/▼ Later history · \d+ context windows? · scroll down to load/u);
		expect(requestsIn(text)).toBeLessThanOrEqual(3);
		// The live context remains below the loaded history.
		expect(text).toContain(`ANSWER ${EPOCHS}`);

		// Returning to new output restores the default window.
		tui.scrollToBottom();
		frame();
		frame();
		text = loaded();
		expect(text).not.toContain("REQUEST 0");
		expect(text).not.toContain("▼");
		expect(text).toContain(`ANSWER ${EPOCHS - 1}`);
	});
});

test("a viewport held at the top loads one page per move instead of the whole history", async () => {
	await withSession(seed, ({ tui, frame, head }) => {
		frame();
		frame();
		const heads = new Set([head()]);
		tui.scrollToTop();
		// Without further moves, later frames only hold the anchor; they never load another page.
		for (let step = 0; step < 50; step++) {
			frame();
			heads.add(head());
		}
		expect(heads.size).toBe(2);
		tui.scrollToTop();
		for (let step = 0; step < 50; step++) {
			frame();
			heads.add(head());
		}
		expect(heads.size).toBe(3);
	});
});

test("history pages start only where an activity fold already ends", async () => {
	await withSession(seed, ({ tui, frame, chat }) => {
		frame();
		for (let step = 0; step < 20; step++) {
			tui.scrollToTop();
			frame();
			frame();
		}
		const starts = chat.children.flatMap((child, index) =>
			child.constructor.name === "PageStart" ? [chat.children[index + 1]] : [],
		);
		expect(starts.length).toBeGreaterThan(3);
		for (const next of starts) {
			// A page never opens with a tool call, or with an assistant message whose thinking would extend a fold.
			expect(next?.constructor.name).not.toBe("ToolExecutionComponent");
			if (next instanceof AssistantMessageComponent) {
				const message: AssistantMessage = Reflect.get(next, "lastMessage");
				expect(message.content.find((part) => part.type !== "toolCall")?.type).toBe("text");
			}
		}
	});
});

test("scrolling down through released pages loads them back in order", async () => {
	await withSession(seed, ({ tui, frame, loaded, screen }) => {
		frame();
		for (let step = 0; step < 40 * EPOCHS && !screen().some((line) => line.includes("REQUEST 0")); step++) {
			tui.scrollToTop();
			frame();
			frame();
		}
		expect(loaded()).toContain("▼");
		const seen = new Set<number>();
		const firstOnScreen: number[] = [];
		const record = () => {
			let first: number | undefined;
			for (const line of screen()) {
				const match = /^\s*(?:REQUEST|epoch) (\d+)\b/u.exec(line);
				if (!match) continue;
				first ??= Number(match[1]);
				if (line.trimStart().startsWith("REQUEST")) seen.add(Number(match[1]));
			}
			if (first !== undefined) firstOnScreen.push(first);
		};
		record();
		for (let step = 0; step < 80 * EPOCHS && !tui.isFollowingOutput; step++) {
			tui.scrollBy(ROWS / 2);
			frame();
			frame();
			record();
		}
		expect(tui.isFollowingOutput).toBe(true);
		expect(loaded()).not.toContain("▼");
		// Releasing pages above the reader never moves the view backwards.
		expect(firstOnScreen).toEqual([...firstOnScreen].sort((a, b) => a - b));
		// Every saved epoch was shown on the way down.
		for (let epoch = 0; epoch < EPOCHS; epoch++) expect(seen.has(epoch)).toBe(true);
	});
});

test("a session with many compactions builds components only for the loaded pages", async () => {
	await withSession(
		(manager) => seed(manager, 150, 8),
		({ frame, chat, loaded }) => {
			frame();
			// The live context and the newest pages, not thousands of components for 150 epochs.
			expect(chat.children.length).toBeLessThan(300);
			expect(loaded()).toMatch(/▲ Earlier history · 14\d context windows/u);
			expect(loaded()).not.toMatch(/REQUEST 0\b/u);
		},
	);
});

test("short saved history fills the screen so earlier pages stay reachable without scrolling", async () => {
	await withSession(
		(manager) => {
			for (let epoch = 0; epoch <= 120; epoch++) {
				if (epoch > 0) manager.appendCompaction(`SUMMARY ${epoch}`, null, epoch);
				manager.appendMessage({ role: "user", content: `TINY ${epoch}`, timestamp: epoch });
			}
		},
		({ frame, loaded, tui }) => {
			for (let step = 0; step < 200; step++) frame();
			const text = loaded();
			// More than the default window is loaded, and loading stopped once the screen was full.
			expect(text).toContain("TINY 80");
			expect(text).not.toMatch(/TINY 0\b/u);
			expect(tui.isFollowingOutput).toBe(true);
		},
		300,
	);
});
