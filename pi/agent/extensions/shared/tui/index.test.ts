import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	AnimationScheduler,
	createResource,
	createSelectController,
	createSurfaceRegistry,
	enforceNoRawTuiSurfaceCalls,
	padToVisibleWidth,
	renderView,
	runningFrame,
	shineText,
	themeRoleToRgb,
	triangleWave,
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

	test("paints requested view backgrounds across foreground resets", () => {
		const backgroundAnsi = "\x1b[48;2;250;250;250m";
		const ansiTheme = {
			fg(role: string, text: string) {
				return role === "accent" ? `\x1b[31m${text}\x1b[0m` : text;
			},
			bg(role: string, text: string) {
				return role === "customMessageBg" ? `${backgroundAnsi}${text}\x1b[49m` : text;
			},
			getBgAnsi(role: string) {
				return role === "customMessageBg" ? backgroundAnsi : undefined;
			},
		};

		const [line = ""] = renderView(view.text("light", { tone: "accent" }), {
			width: 10,
			theme: ansiTheme,
			background: "customMessageBg",
		});

		expect(line).toBe(`${backgroundAnsi}\x1b[31mlight\x1b[0m${backgroundAnsi}     \x1b[0m`);
		expect(visibleWidth(line)).toBe(10);
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

	test("animation primitives render shared spinner, shine, pulse color math", () => {
		const rgbTheme = {
			fg(role: string, text: string) {
				return role === "accent" ? `\x1b[38;2;100;120;200m${text}\x1b[39m` : `<${role}>${text}</${role}>`;
			},
		};

		expect(runningFrame(undefined)).toBe("⠋");
		expect(runningFrame(240)).toBe("⠹");
		expect(themeRoleToRgb(rgbTheme, "accent")).toEqual([100, 120, 200]);
		expect(triangleWave(600, 1_200, 0.45, 1.45)).toBe(1.45);

		const early = shineText(rgbTheme, "Working", 0, { role: "accent" });
		const later = shineText(rgbTheme, "Working", 240, { role: "accent" });
		expect(early).not.toBe(later);
		expect(early).toContain("\x1b[38;2;55;66;110m");
		expect(later).toContain("\x1b[38;2;155;186;255m");
	});

	test("text primitives pad to visible width with optional truncation", () => {
		const truncated = padToVisibleWidth("abcdef", 4);

		expect(padToVisibleWidth("abc", 5)).toBe("abc  ");
		expect(truncated.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).toBe("abc…");
		expect(visibleWidth(truncated)).toBe(4);
		expect(padToVisibleWidth("\x1b[31mred\x1b[39m", 5, { truncate: false })).toBe("\x1b[31mred\x1b[39m  ");
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
