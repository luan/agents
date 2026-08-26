import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ensureActionsRegistry } from "pi-libactions/sdk";
import { registerProcessHubHost, retainProcessHubAction } from "../src/contributions/actions.ts";
import type { ExecProcessSnapshot, PtyDataEvent, UnifiedExecResult } from "../src/session-manager.ts";
import { ProcessHub } from "../src/ui/process-hub.ts";
import { ProcessHubCollection, type ProcessHubManager, ProcessTerminalStore } from "../src/ui/process-store.ts";

const theme = {
	name: "process-hub-test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[38;2;120;160;220m",
	getBgAnsi: () => "\x1b[48;2;20;24;30m",
} as never as Theme;

function result(): UnifiedExecResult {
	return { chunk_id: "chunk", wall_time_seconds: 0, output: "", output_truncated: false };
}

function snapshot(overrides: Partial<ExecProcessSnapshot> = {}): ExecProcessSnapshot {
	return {
		id: 1,
		command: "printf pipe-output",
		cwd: "/tmp",
		tty: false,
		stdinOpen: false,
		state: "running",
		startedAtMs: 1,
		output: "pipe-output",
		outputTruncated: false,
		...overrides,
	};
}

test("process hub browses output and delegates explicit process controls", async () => {
	let snapshots: readonly ExecProcessSnapshot[] = [
		snapshot(),
		snapshot({ id: 2, command: "interactive", tty: true, stdinOpen: true, output: "prompt> " }),
	];
	let processListener: ((value: readonly ExecProcessSnapshot[]) => void) | undefined;
	let ptyListener: ((event: PtyDataEvent) => void) | undefined;
	const calls: string[] = [];
	const manager = {
		exec: async () => result(),
		write: async () => result(),
		getSessionCommand: () => undefined,
		listProcesses: () => snapshots,
		subscribeProcesses(listener) {
			processListener = listener;
			listener(snapshots);
			return () => {
				processListener = undefined;
			};
		},
		onPtyData(listener) {
			ptyListener = listener;
			return () => {
				ptyListener = undefined;
			};
		},
		async interrupt(id) {
			calls.push(`interrupt:${id}`);
			return true;
		},
		async terminate(id) {
			calls.push(`terminate:${id}`);
			return true;
		},
		async resize(id, cols, rows) {
			calls.push(`resize:${id}:${cols}x${rows}`);
			return true;
		},
		async sendInput(id, chars) {
			calls.push(`input:${id}:${chars}`);
			return true;
		},
		async shutdown() {},
	} satisfies ProcessHubManager;
	const store = new ProcessTerminalStore(manager);
	const model = new ProcessHubCollection([{ sessionId: "root", path: "/root", store, manager }]);
	let renders = 0;
	let closed = 0;
	const tui = { terminal: { rows: 16 }, requestRender: () => renders++ } as never;
	const hub = new ProcessHub(model, tui, theme, () => closed++);

	expect(stripTerminalSequences(hub.render(80).join("\n"))).toContain("printf pipe-output");
	hub.handleInput("\r");
	expect(stripTerminalSequences(hub.render(80).join("\n"))).toContain("pipe-output");
	hub.handleInput("\u001d");
	hub.handleInput("j");
	hub.handleInput("\r");
	hub.render(80);
	ptyListener?.({ processId: 2, data: "\x1b[2J\x1b[Hready" });
	await store.terminal(2)?.drain();
	expect(stripTerminalSequences(hub.render(80).join("\n"))).toContain("ready");
	hub.handleInput("x");
	expect(calls).toContain("input:2:x");
	hub.handleInput("\u001d");
	hub.handleInput("i");
	hub.handleInput("x");
	expect(calls).toContain("interrupt:2");
	expect(calls).toContain("terminate:2");

	snapshots = [snapshots[0]!];
	processListener?.(snapshots);
	expect(renders).toBeGreaterThan(0);
	hub.handleInput("\u001bs");
	expect(closed).toBe(1);
	hub.dispose();
	store.dispose();
});

test("TTY resize keeps the current screen until the native process redraws", async () => {
	const tty = snapshot({ command: "vim", tty: true, stdinOpen: true, output: "\x1b[?1049h\x1b[2J\x1b[HVIM WELCOME" });
	let ptyListener: ((event: PtyDataEvent) => void) | undefined;
	const manager = {
		exec: async () => result(),
		write: async () => result(),
		getSessionCommand: () => undefined,
		listProcesses: () => [tty],
		subscribeProcesses(listener) {
			listener([tty]);
			return () => {};
		},
		onPtyData(listener) {
			ptyListener = listener;
			return () => {
				ptyListener = undefined;
			};
		},
		async interrupt() {
			return true;
		},
		async terminate() {
			return true;
		},
		async resize() {
			return true;
		},
		async sendInput() {
			return true;
		},
		async shutdown() {},
	} satisfies ProcessHubManager;
	const store = new ProcessTerminalStore(manager);
	const terminal = store.terminal(1);
	expect(terminal?.cols).toBe(80);
	expect(stripTerminalSequences(terminal?.renderLines({ cursor: false }).join("\n") ?? "")).toContain("VIM WELCOME");

	await store.resize(1, 78, 17);
	expect(terminal?.cols).toBe(80);
	expect(stripTerminalSequences(terminal?.renderLines({ cursor: false }).join("\n") ?? "")).toContain("VIM WELCOME");

	ptyListener?.({ processId: 1, data: "\x1b[2J\x1b[HREDRAW AT NEW SIZE" });
	await terminal?.drain();
	expect(terminal?.cols).toBe(78);
	expect(terminal?.rows).toBe(17);
	expect(stripTerminalSequences(terminal?.renderLines({ cursor: false }).join("\n") ?? "")).toContain(
		"REDRAW AT NEW SIZE",
	);
	store.dispose();
});

test("process collection keeps duplicate child IDs distinct and routes controls to their owners", async () => {
	const calls: string[] = [];
	const manager = (owner: string, process: ExecProcessSnapshot): ProcessHubManager => ({
		...emptyManager(),
		listProcesses: () => [process],
		subscribeProcesses(listener) {
			listener([process]);
			return () => {};
		},
		interrupt: async (id) => {
			calls.push(`${owner}:interrupt:${id}`);
			return true;
		},
		terminate: async (id) => {
			calls.push(`${owner}:terminate:${id}`);
			return true;
		},
		resize: async (id) => {
			calls.push(`${owner}:resize:${id}`);
			return true;
		},
		sendInput: async (id) => {
			calls.push(`${owner}:input:${id}`);
			return true;
		},
	});
	const rootManager = manager("root", snapshot({ id: 1, command: "root command" }));
	const childManager = manager("child", snapshot({ id: 1, command: "child command" }));
	const rootStore = new ProcessTerminalStore(rootManager);
	const childStore = new ProcessTerminalStore(childManager);
	const collection = new ProcessHubCollection([
		{ sessionId: "root-session", path: "/root", store: rootStore, manager: rootManager },
		{ sessionId: "child-session", path: "/root/child", store: childStore, manager: childManager },
	]);

	const [root, child] = collection.list();
	expect(root?.id).toBe(1);
	expect(child?.id).toBe(1);
	expect(root?.key).not.toBe(child?.key);
	expect(child?.owner).toBe("/root/child");
	await collection.interrupt(child!.key);
	await collection.terminate(root!.key);
	await collection.resize(child!.key, 80, 20);
	await collection.sendInput(root!.key, "x");
	expect(calls).toEqual(["child:interrupt:1", "root:terminate:1", "child:resize:1", "root:input:1"]);
	rootStore.dispose();
	childStore.dispose();
});

test("process hub action opens the invoking session and its descendant process sources", async () => {
	const releaseFirst = retainProcessHubAction();
	const releaseSecond = retainProcessHubAction();
	const hierarchyKey = Symbol.for("pi-subagents/session-hierarchy/v1");
	const previousHierarchy = Reflect.get(globalThis, hierarchyKey);
	Reflect.set(globalThis, hierarchyKey, {
		protocol: "pi-subagents/session-hierarchy/v1",
		version: 1,
		descendants: () => [
			{ sessionId: "session-a", path: "/root" },
			{ sessionId: "session-child", path: "/root/child" },
		],
	});
	const manager = emptyManager();
	const childManager = emptyManager();
	const unrelatedManager = emptyManager();
	const stores = [manager, childManager, unrelatedManager].map((candidate) => new ProcessTerminalStore(candidate));
	let opened: readonly string[] = [];
	const removeHost = registerProcessHubHost("session-a", {
		store: stores[0]!,
		manager,
		open: (_ctx, sources) => {
			opened = sources.map(({ path }) => path);
		},
	});
	const removeChild = registerProcessHubHost("session-child", {
		store: stores[1]!,
		manager: childManager,
		open() {},
	});
	const removeUnrelated = registerProcessHubHost("unrelated", {
		store: stores[2]!,
		manager: unrelatedManager,
		open() {},
	});
	const context = {
		sessionManager: { getSessionId: () => "session-a" },
		ui: { notify() {} },
	} as never;

	await ensureActionsRegistry().find("processes.open")?.run(context);
	expect(opened).toEqual(["/root", "/root/child"]);
	releaseFirst();
	expect(ensureActionsRegistry().find("processes.open")).toBeDefined();
	releaseSecond();
	removeHost();
	removeChild();
	removeUnrelated();
	for (const store of stores) store.dispose();
	if (previousHierarchy === undefined) Reflect.deleteProperty(globalThis, hierarchyKey);
	else Reflect.set(globalThis, hierarchyKey, previousHierarchy);
});

function emptyManager(): ProcessHubManager {
	return {
		exec: async () => result(),
		write: async () => result(),
		getSessionCommand: () => undefined,
		listProcesses: () => [],
		subscribeProcesses(listener) {
			listener([]);
			return () => {};
		},
		onPtyData: () => () => {},
		interrupt: async () => true,
		terminate: async () => true,
		resize: async () => true,
		sendInput: async () => true,
		shutdown: async () => {},
	};
}
