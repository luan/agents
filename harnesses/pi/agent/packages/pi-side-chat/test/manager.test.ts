import { expect, test } from "bun:test";
import { SideChatManager } from "../src/manager.ts";
import type { SideChatState } from "../src/state.ts";

const runtime = {
	cwd: "/tmp/project",
	sessionRoot: "/tmp/side-chat-overlay",
	theme: {
		name: "test",
		getColorMode: () => "truecolor",
		getFgAnsi: () => "\x1b[39m",
		getBgAnsi: () => "\x1b[49m",
	},
	inheritedEntries: () => [],
	writeSession: () => {},
} as never;
const firstId = "11111111-1111-4111-8111-111111111111";
const tab = (sessionId: string, number: number) => ({
	id: `side-chat:${sessionId}`,
	label: `Side ${number}`,
	sessionId,
});
const restoredState: SideChatState = {
	version: 1,
	nextNumber: 3,
	tabs: [tab(firstId, 1), tab("22222222-2222-4222-8222-222222222222", 2)],
};

test("falls back to the overlay host when no side panel is attached", async () => {
	let overlays = 0;
	const entries: unknown[] = [];
	const pi = { appendEntry: (_type: string, state: unknown) => entries.push(state) } as never;
	const context = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: {
			custom: async () => {
				overlays += 1;
			},
		},
		sessionManager: { getSessionDir: () => "/tmp/side-chat-overlay", getBranch: () => [] },
	} as never;
	const manager = new SideChatManager(
		pi,
		context,
		runtime,
		{ version: 1, nextNumber: 1, tabs: [] },
		() => firstId,
		Object.create(null) as typeof globalThis,
	);
	await manager.newChat();
	expect(overlays).toBe(1);
	expect(entries).toHaveLength(1);
	manager.dispose();
});

test("resumes the newest persisted chat in the standalone overlay", async () => {
	let overlays = 0;
	const context = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: {
			custom: async () => {
				overlays += 1;
			},
		},
		sessionManager: { getSessionDir: () => "/tmp/side-chat-overlay", getBranch: () => [] },
	} as never;
	const manager = new SideChatManager(
		{ appendEntry() {} } as never,
		context,
		runtime,
		restoredState,
		() => "unused",
		Object.create(null) as typeof globalThis,
	);

	await manager.restoreStandalone();
	expect(overlays).toBe(1);
	manager.dispose();
});

test("restores panel tabs without starting hidden child sessions", () => {
	const scope = Object.create(null) as typeof globalThis;
	const restored: string[] = [];
	const panel = {
		registerEmptyAction: () => () => {},
		restoreTab: (tab: { id: string }) => restored.push(tab.id),
		removeTab() {},
	} as never;
	const manager = new SideChatManager(
		{ appendEntry() {} } as never,
		{ cwd: "/tmp/project", hasUI: true, ui: {} } as never,
		runtime,
		restoredState,
		() => "unused",
		scope,
	);
	const detach = manager.attachPanel(panel);
	expect(restored).toHaveLength(2);
	expect(Reflect.get(scope, Symbol.for("pi-libtui/pty-host/v2"))).toBeUndefined();
	detach();
	manager.dispose();
	expect(Reflect.get(scope, Symbol.for("pi-libtui/pty-host/v2"))).toBeUndefined();
});

test("transfers live child ownership across reload without replacing the process", () => {
	const state: SideChatState = { version: 1, nextNumber: 2, tabs: [tab(firstId, 1)] };
	let onExit: (() => void) | undefined;
	let disposals = 0;
	const process = {
		setOnExit: (listener: (() => void) | undefined) => {
			onExit = listener;
		},
		dispose: () => {
			disposals += 1;
		},
	} as never;
	const processes = new Map([[state.tabs[0]!.id, process]]);
	const entries: SideChatState[] = [];
	const manager = () =>
		new SideChatManager(
			{ appendEntry: (_type: string, entry: SideChatState) => entries.push(entry) } as never,
			{ cwd: "/tmp/project", hasUI: true, ui: {} } as never,
			runtime,
			state,
			() => "unused",
			Object.create(null) as typeof globalThis,
			processes,
		);

	manager().dispose({ preserveProcesses: true });
	expect(disposals).toBe(0);
	expect(onExit).toBeUndefined();
	manager();
	expect(onExit).toBeFunction();
	onExit?.();
	expect(disposals).toBe(1);
	expect(processes.size).toBe(0);
	expect(entries.at(-1)?.tabs).toEqual([]);
});
