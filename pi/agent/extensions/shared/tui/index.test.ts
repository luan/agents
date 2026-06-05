import { describe, expect, test } from "bun:test";
import {
	AnimationScheduler,
	createResource,
	createSelectController,
	createSurfaceRegistry,
	enforceNoRawTuiSurfaceCalls,
	renderView,
	view,
} from "./index";

const theme = {
	fg(role: string, text: string) {
		return `<${role}>${text}</${role}>`;
	},
	bg(role: string, text: string) {
		return `<bg:${role}>${text}</bg:${role}>`;
	},
	bold(text: string) {
		return `**${text}**`;
	},
};

describe("Extension TUI ViewNodes", () => {
	test("renders semantic panels with width-bounded rows", () => {
		const node = view.panel({
			title: view.text("Tasks", { tone: "accent", emphasis: "bold" }),
			children: [
				view.row([
					view.statusBadge("running", { tone: "warning" }),
					view.text("Implement shared TUI renderer", { tone: "text" }),
				]),
				view.keyHints(["enter open", "esc close"]),
			],
		});

		const lines = renderView(node, { width: 38, height: 6, theme });

		expect(lines).toEqual([
			"╭─ <accent>**Tasks**</accent> ────────────────────────╮",
			"│ <warning>running</warning> <text>Implement shared TUI rend…</text> │",
			"│ <dim>enter open · esc close</dim>             │",
			"╰────────────────────────────────────╯",
		]);
		expect(lines.every((line) => line.length > 0)).toBe(true);
	});

	test("summarizes overflowing lists when requested", () => {
		const lines = renderView(
			view.list({
				items: [
					{ id: "a", label: view.text("alpha") },
					{ id: "b", label: view.text("bravo") },
					{ id: "c", label: view.text("charlie") },
				],
				maxRows: 2,
				overflow: "summarize",
			}),
			{ width: 20, height: 2, theme },
		);

		expect(lines).toEqual(["<text>alpha</text>", "<dim>+2 more</dim>"]);
	});

	test("selection controller moves and versions interaction state", () => {
		const controller = createSelectController(["a", "b", "c"], { selectedId: "b" });

		const initialVersion = controller.version;
		controller.move(1);
		expect(controller.selectedId).toBe("c");
		expect(controller.version).toBeGreaterThan(initialVersion);

		controller.move(1);
		expect(controller.selectedId).toBe("c");
		expect(controller.version).toBeGreaterThan(initialVersion);
	});

	test("shared and exclusive surfaces resolve deterministically", () => {
		const registry = createSurfaceRegistry();
		registry.contribute("widgets.aboveEditor", { id: "later", priority: 1, view: view.text("later") });
		registry.contribute("widgets.aboveEditor", { id: "earlier", priority: 10, view: view.text("earlier") });

		expect(registry.resolveShared("widgets.aboveEditor").map((entry) => entry.id)).toEqual(["earlier", "later"]);

		registry.replace("working", { id: "low", priority: 1, view: view.text("low") });
		registry.replace("working", { id: "high", priority: 5, view: view.text("high") });

		expect(registry.resolveExclusive("working")?.id).toBe("high");
		expect(registry.diagnostics()).toEqual([]);
	});

	test("exclusive surfaces diagnose equal-priority replacements", () => {
		const registry = createSurfaceRegistry();
		registry.replace("editor", { id: "vim", priority: 10, view: view.text("vim") });
		registry.replace("editor", { id: "modal", priority: 10, view: view.text("modal") });

		expect(registry.resolveExclusive("editor")?.id).toBe("vim");
		expect(registry.diagnostics()).toEqual([
			{
				code: "exclusive-surface-conflict",
				surface: "editor",
				message: 'Exclusive surface "editor" has competing replacements at priority 10: vim, modal',
			},
		]);
	});

	test("animation scheduler wakes only for mounted animated views", () => {
		const scheduler = new AnimationScheduler();
		const renders: number[] = [];

		const mount = scheduler.mount({
			id: "working-dot",
			intervalMs: 120,
			onFrame: (frame) => renders.push(frame),
		});

		expect(scheduler.nextDelay(1_000)).toBe(120);
		scheduler.tick(1_120);
		scheduler.tick(1_240);
		mount.dispose();
		expect(scheduler.nextDelay(1_240)).toBeUndefined();
		expect(renders).toEqual([1, 2]);
	});

	test("resources expose loading, ready, stale, error, and cancellation behavior", async () => {
		let aborted = false;
		const resource = createResource({
			load: async ({ signal }) => {
				await Promise.resolve();
				aborted = signal.aborted;
				return "ready";
			},
		});

		const loading = resource.refresh();
		expect(resource.state.kind).toBe("loading");
		await loading;
		expect(resource.state).toMatchObject({ kind: "ready", data: "ready" });

		const stale = resource.refresh();
		expect(resource.state.kind).toBe("stale");
		resource.cancel();
		await stale;
		expect(aborted).toBe(true);
	});

	test("architecture enforcement reports raw TUI surface calls outside adapters", () => {
		const violations = enforceNoRawTuiSurfaceCalls([
			{
				path: "pi/agent/extensions/tasks/index.ts",
				source: "ctx.ui.setWidget('project-tasks', [])",
			},
			{
				path: "pi/agent/extensions/shared/tui/adapters/pi-tui.ts",
				source: "ctx.ui.setWidget('project-tasks', [])",
			},
		]);

		expect(violations).toEqual([
			{
				path: "pi/agent/extensions/tasks/index.ts",
				method: "setWidget",
				message: "Raw ctx.ui.setWidget surface call must go through shared/tui",
			},
		]);
	});
});
