import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import type { AgentHubSnapshot, AgentHubSnapshotSource } from "../src/ui/agent-browser.ts";
import { AgentWidget } from "../src/ui/agent-widget.ts";

const theme = {
	name: "agent-widget-test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[38;2;120;160;220m",
	getBgAnsi: () => "\x1b[48;2;20;24;30m",
} as never as Theme;

test("opens the clicked agent row in Agent Hub", () => {
	const snapshot = activeSnapshot();
	let listener: ((snapshot: AgentHubSnapshot) => void) | undefined;
	const source: AgentHubSnapshotSource = {
		getSnapshot: () => snapshot,
		subscribe(notify) {
			listener = notify;
			return () => {
				listener = undefined;
			};
		},
	};
	const opened: string[] = [];
	const widget = new AgentWidget(source, (agentId) => opened.push(agentId));
	let renders = 0;
	let factory:
		| ((tui: never, theme: Theme) => { render(width: number): string[]; onMouse(event: TuiMouseEvent): boolean })
		| undefined;
	const ui = {
		setStatus() {},
		setWidget(_id: string, value: typeof factory) {
			factory = value;
		},
	} as never;
	widget.setUICtx(ui);

	const component = factory?.({ terminal: { rows: 24 }, requestRender: () => renders++ } as never, theme);
	const rendered = Bun.stripANSI(component?.render(100).join("\n") ?? "");
	expect(rendered).toContain("Agents · 1 running");
	expect(rendered).toContain("worker");
	expect(component?.onMouse(mouse("move", 1, 10))).toBe(true);
	expect(renders).toBeGreaterThan(0);
	component?.onMouse(mouse("press", 1, 10, 0));
	component?.onMouse(mouse("release", 1, 10, 0));
	expect(opened).toEqual(["/root/worker"]);

	widget.dispose();
	expect(listener).toBeUndefined();
});

function activeSnapshot(): AgentHubSnapshot {
	return {
		generation: 1,
		agents: [
			{
				id: "/root/worker",
				rootSessionId: "root",
				parentId: "/root",
				cwd: "/tmp",
				description: "worker",
				status: "running",
				message: "working",
				startedAt: Date.now() - 1_000,
				toolUses: 0,
				cost: 0,
				tokenCount: 0,
				compactions: 0,
				transcriptAvailable: true,
				transcript: {
					getMessages: () => [],
					generation: () => 0,
					preview: () => ({ kind: "assistant", text: "working" }),
					subscribe: () => () => {},
				},
			},
		],
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
