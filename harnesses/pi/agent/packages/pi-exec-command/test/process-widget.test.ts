import { afterEach, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE, whenSyntaxReady } from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import type { ExecProcessSnapshot, PtyDataEvent, UnifiedExecResult } from "../src/session-manager.ts";
import { type ProcessHubManager, ProcessTerminalStore } from "../src/ui/process-store.ts";
import { ProcessWidget } from "../src/ui/process-widget.ts";

const theme = {
	name: "process-widget-test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[38;2;120;160;220m",
	getBgAnsi: () => "\x1b[48;2;20;24;30m",
} as never as Theme;

afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

test("renders animated syntax-highlighted process rows and opens the clicked process", async () => {
	configureTuiAppearance({
		...DEFAULT_TUI_APPEARANCE,
		iconPack: "nerd-fonts",
		activityIndicator: "static",
		textEffect: "off",
		pulseEffect: "off",
	});
	await new Promise<void>((resolve) => whenSyntaxReady(resolve));
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
	const opened: number[] = [];
	const widget = new ProcessWidget(store, (processId) => opened.push(processId));
	let status: string | undefined;
	let factory:
		| ((tui: never, theme: Theme) => { render(width: number): string[]; onMouse(event: TuiMouseEvent): boolean })
		| undefined;
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
	const rows = component?.render(100) ?? [];
	const rendered = Bun.stripANSI(rows.join("\n"));
	expect(rendered).toContain(" Processes · 1 running");
	expect(rendered).toContain("Processes · 1 running");
	expect(rendered).toContain("● #3");
	expect(rendered).toContain("#3");
	expect(rendered).toContain('for i in 1 2; do echo "$i"; done');
	expect(rendered).toContain("working");
	expect(new Set(rows[1]?.match(/\x1b\[38;[^m]*m/gu) ?? []).size).toBeGreaterThan(2);
	component?.onMouse(mouse("press", 1, 10, 0));
	component?.onMouse(mouse("release", 1, 10, 0));
	expect(opened).toEqual([3]);

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
		command: 'for i in 1 2; do echo "$i"; done',
		cwd: "/tmp",
		shell: "/bin/zsh",
		tty: false,
		stdinOpen: false,
		state: "running",
		startedAtMs: Date.now() - 1_000,
		output: "working\n",
		outputTruncated: false,
	};
}

function mouse(type: TuiMouseEvent["type"], row: number, col: number, button?: 0 | 1 | 2): TuiMouseEvent {
	return {
		type,
		row,
		col,
		screenRow: row,
		screenCol: col,
		button,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

function result(): UnifiedExecResult {
	return { chunk_id: "chunk", wall_time_seconds: 0, output: "", output_truncated: false };
}
