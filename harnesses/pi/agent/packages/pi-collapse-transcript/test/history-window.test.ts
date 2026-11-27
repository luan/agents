import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	DefaultResourceLoader,
	InteractiveMode,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, type TuiAltScreen } from "@earendil-works/pi-tui";
import transcriptExtension from "../src/extension.ts";

const COLUMNS = 100;
const ROWS = 40;
const EPOCHS = 12;

class CapturedTerminal extends ProcessTerminal {
	private input: ((data: string) => void) | undefined;
	get columns() {
		return COLUMNS;
	}
	get rows() {
		return ROWS;
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
function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "history-fixture",
		model: "fixture",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: 0,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost },
	};
}

/** Each epoch is taller than the viewport, so loading one page moves content by more than a screen. */
function seed(manager: SessionManager, epochs = EPOCHS): void {
	for (let epoch = 0; epoch <= epochs; epoch++) {
		if (epoch > 0) manager.appendCompaction(`SUMMARY ${epoch}`, null, 1_000 * epoch);
		manager.appendMessage({ role: "user", content: `REQUEST ${epoch}`, timestamp: epoch });
		const lines = Array.from({ length: 30 }, (_, line) => `epoch ${epoch} line ${line}`);
		manager.appendMessage(answer(`ANSWER ${epoch}\n\n${lines.join("\n\n")}`));
	}
}

async function open(root: string, manager: SessionManager) {
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
		terminal: new CapturedTerminal(),
		tuiMode: "fullscreen",
		initialThemeSetting: "dark",
	});
	await mode.init();
	if (!captured) throw new Error("Expected the fullscreen TUI");
	const tui = captured;
	const frame = () => tui.renderNow();
	/** Every transcript line that is currently loaded. */
	const loaded = () => Bun.stripANSI(tui.children[0]?.render(COLUMNS).join("\n") ?? "");
	/** The rows painted in the terminal. */
	const screen = (): string[] => {
		const layout: { lines?: string[] } | undefined = Reflect.get(tui, "currentLayout");
		return (layout?.lines ?? []).map((line) => Bun.stripANSI(line).trimEnd());
	};
	return { runtime, mode, tui, frame, loaded, screen };
}

test("fullscreen history loads compaction epochs around the viewport instead of the whole branch", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-history-window-"));
	const manager = SessionManager.create(root, join(root, "sessions"));
	seed(manager);
	const session = await open(root, manager);
	const { tui, frame, loaded, screen } = session;
	try {
		frame();
		frame();
		// The live context and the newest saved epoch are loaded; older epochs are not.
		let text = loaded();
		expect(text).toContain(`ANSWER ${EPOCHS}`);
		expect(text).toContain(`ANSWER ${EPOCHS - 1}`);
		expect(text).not.toContain(`ANSWER ${EPOCHS - 2}`);
		expect(text).toContain(`▲ ${EPOCHS - 1} context windows before this · scroll up to load`);
		expect(text).not.toContain("▼");

		// Reaching the top loads one earlier epoch and keeps the visible rows in place.
		const pendingTools: object = Reflect.get(session.mode, "pendingTools");
		tui.scrollToTop();
		frame();
		const divider = (rows: string[]) =>
			rows.findIndex((line) => line.includes(`${(1_000 * (EPOCHS - 1)).toLocaleString()} tokens before`));
		const anchored = divider(screen());
		const content = (rows: string[]) => rows.slice(anchored, anchored + 10).map((line) => line.slice(0, COLUMNS - 2));
		const before = content(screen());
		expect(anchored).toBeGreaterThanOrEqual(0);
		frame();
		expect(divider(screen())).toBe(anchored);
		expect(content(screen())).toEqual(before);
		expect(loaded()).toContain(`ANSWER ${EPOCHS - 2}`);
		// Rendering a page through Pi's renderer leaves live tool tracking alone.
		expect(Reflect.get(session.mode, "pendingTools")).toBe(pendingTools);

		// Keep reading upwards until the first saved epoch is on screen.
		for (let step = 0; step < 4 * EPOCHS && !screen().some((line) => line.includes("REQUEST 0")); step++) {
			tui.scrollToTop();
			frame();
			frame();
		}
		expect(screen().some((line) => line.includes("REQUEST 0"))).toBe(true);
		text = loaded();
		expect(text).not.toContain("▲");
		// Pages far below the reader were released, leaving a marker for them.
		expect(text).not.toContain(`ANSWER ${EPOCHS - 1}`);
		expect(text).toMatch(/▼ \d+ context windows? after this · scroll down to load/u);
		const loadedPages = (text.match(/^\s*ANSWER \d+/gmu) ?? []).length;
		expect(loadedPages).toBeLessThanOrEqual(5);
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
		expect(text).toContain(`▲ ${EPOCHS - 1} context windows before this`);
	} finally {
		session.mode.stop();
		await session.runtime.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("scrolling down through released pages loads them back in order", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-history-window-"));
	const manager = SessionManager.create(root, join(root, "sessions"));
	seed(manager);
	const session = await open(root, manager);
	const { tui, frame, loaded, screen } = session;
	try {
		frame();
		for (let step = 0; step < 4 * EPOCHS && !screen().some((line) => line.includes("REQUEST 0")); step++) {
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
		for (let step = 0; step < 40 * EPOCHS && !tui.isFollowingOutput; step++) {
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
	} finally {
		session.mode.stop();
		await session.runtime.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("a session with many compactions builds components only for the loaded window", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-history-window-"));
	const manager = SessionManager.create(root, join(root, "sessions"));
	seed(manager, 150);
	const session = await open(root, manager);
	try {
		session.frame();
		const chat: { children: unknown[] } = Reflect.get(session.mode, "chatContainer");
		// The live context and one saved epoch, not 150 epochs of messages.
		expect(chat.children.length).toBeLessThan(40);
		expect(session.loaded()).toContain("▲ 149 context windows before this");
		expect(session.loaded()).not.toMatch(/REQUEST 0\b/u);
	} finally {
		session.mode.stop();
		await session.runtime.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("short saved history fills the screen so earlier windows stay reachable without scrolling", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-history-window-"));
	const manager = SessionManager.create(root, join(root, "sessions"));
	for (let epoch = 0; epoch <= 30; epoch++) {
		if (epoch > 0) manager.appendCompaction(`SUMMARY ${epoch}`, null, epoch);
		manager.appendMessage({ role: "user", content: `TINY ${epoch}`, timestamp: epoch });
	}
	const session = await open(root, manager);
	try {
		for (let step = 0; step < 40; step++) session.frame();
		const text = session.loaded();
		// More than the default single window is loaded, and loading stopped once the screen was full.
		expect(text).toContain("TINY 28");
		expect(text).toContain("TINY 25");
		expect(text).not.toMatch(/TINY 0\b/u);
		expect(session.tui.isFollowingOutput).toBe(true);
	} finally {
		session.mode.stop();
		await session.runtime.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
