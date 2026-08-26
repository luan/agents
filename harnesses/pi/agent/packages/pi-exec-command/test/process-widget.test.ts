import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExecProcessSnapshot, PtyDataEvent, UnifiedExecResult } from "../src/session-manager.ts";
import { ProcessTerminalStore, type ProcessHubManager } from "../src/ui/process-store.ts";
import { ProcessWidget } from "../src/ui/process-widget.ts";

const theme = {
	name: "process-widget-test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[38;2;120;160;220m",
	getBgAnsi: () => "\x1b[48;2;20;24;30m",
} as never as Theme;

test("shows running processes globally and clears itself after exit", () => {
	let snapshots: readonly ExecProcessSnapshot[] = [snapshot()];
	let processListener: ((value: readonly ExecProcessSnapshot[]) => void) | undefined;
	let ptyListener: ((event: PtyDataEvent) => void) | undefined;
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
	const widget = new ProcessWidget(store);
	let status: string | undefined;
	let factory: ((tui: never, theme: Theme) => { render(width: number): string[] }) | undefined;
	const ui = {
		setStatus(_id: string, value: string | undefined) {
			status = value;
		},
		setWidget(_id: string, value: typeof factory) {
			factory = value;
		},
	} as never;
	widget.setUICtx(ui);

	expect(status).toBe("1 running process");
	const component = factory?.({ terminal: { rows: 24 }, requestRender() {} } as never, theme);
	const rendered = Bun.stripANSI(component?.render(100).join("\n") ?? "");
	expect(rendered).toContain("Processes · 1 running");
	expect(rendered).toContain("#3");
	expect(rendered).toContain("sleep 30");
	expect(rendered).toContain("working");

	snapshots = [{ ...snapshots[0]!, state: "exited", exitCode: 0, finishedAtMs: Date.now() }];
	processListener?.(snapshots);
	expect(status).toBeUndefined();
	expect(factory).toBeUndefined();

	widget.dispose();
	store.dispose();
	expect(processListener).toBeUndefined();
	expect(ptyListener).toBeUndefined();
});

function snapshot(): ExecProcessSnapshot {
	return {
		id: 3,
		command: "sleep 30",
		cwd: "/tmp",
		tty: false,
		stdinOpen: false,
		state: "running",
		startedAtMs: Date.now() - 1_000,
		output: "working\n",
		outputTruncated: false,
	};
}

function result(): UnifiedExecResult {
	return { chunk_id: "chunk", wall_time_seconds: 0, output: "", output_truncated: false };
}
