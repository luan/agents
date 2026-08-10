import { describe, expect, test } from "bun:test";
import {
	AnimationRenderScheduler,
	AnimationScheduler,
	createResource,
	createSelectController,
	createSurfaceRegistry,
	enforceNoRawTuiSurfaceCalls,
	pulseGlyph,
	shineText,
	view,
} from "./index";

describe("Extension TUI ViewNodes", () => {
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

	test("animation color lookup is cached across frames", () => {
		let colorReads = 0;
		const theme = {
			fg(_role: string, text: string) {
				colorReads++;
				return `\x1b[38;2;100;120;200m${text}\x1b[39m`;
			},
		};

		shineText(theme, "Working", 0);
		shineText(theme, "Working", 80);
		pulseGlyph(theme, "●", 160);

		expect(colorReads).toBe(1);
	});
	test("animation render scheduler deduplicates concurrent extension targets", () => {
		const callbacks: (() => void)[] = [];
		let stopped = 0;
		const scheduler = new AnimationRenderScheduler(
			(callback) => {
				callbacks.push(callback);
				return { unref() {} } as ReturnType<typeof setInterval>;
			},
			() => {
				stopped++;
			},
		);
		let renderAllowed = false;
		scheduler.setRenderGuard(() => renderAllowed);
		let renders = 0;
		let frames = 0;
		let unguardedRenders = 0;
		const target = { requestRender: () => renders++ };
		const first = scheduler.mount(target, 80, () => frames++);
		const second = scheduler.mount(target, 80);
		const other = scheduler.mount({ requestRender: () => renders++ }, 80);
		const unguarded = scheduler.mount({ requestRender: () => unguardedRenders++ }, 80, undefined, {
			bypassRenderGuard: true,
		});

		expect(scheduler.activeTimerCount).toBe(1);
		callbacks[0]?.();
		expect(renders).toBe(0);
		expect(frames).toBe(1);
		expect(unguardedRenders).toBe(1);
		renderAllowed = true;
		callbacks[0]?.();
		expect(renders).toBe(2);
		expect(frames).toBe(2);
		expect(unguardedRenders).toBe(2);

		first.dispose();
		second.dispose();
		other.dispose();
		unguarded.dispose();
		expect(scheduler.activeTimerCount).toBe(0);
		expect(stopped).toBe(1);
	});

	test("animation render scheduler uses the fastest cadence per target", () => {
		const callbacks = new Map<number, () => void>();
		let renders = 0;
		const target = { requestRender: () => renders++ };
		const scheduler = new AnimationRenderScheduler((callback, intervalMs) => {
			callbacks.set(intervalMs, callback);
			return { unref() {} } as ReturnType<typeof setInterval>;
		});
		const fast = scheduler.mount(target, 32);
		const slow = scheduler.mount(target, 80);

		callbacks.get(80)?.();
		expect(renders).toBe(0);
		callbacks.get(32)?.();
		expect(renders).toBe(1);

		fast.dispose();
		callbacks.get(80)?.();
		expect(renders).toBe(2);
		slow.dispose();
	});

	test("animation render scheduler does not discard repaint callbacks", () => {
		let callback: (() => void) | undefined;
		let renders = 0;
		let frames = 0;
		const scheduler = new AnimationRenderScheduler(
			(next) => {
				callback = next;
				return { unref() {} } as ReturnType<typeof setInterval>;
			},
			() => {},
		);
		scheduler.mount({ requestRender: () => renders++ }, 80, () => frames++);

		callback?.();
		callback?.();
		callback?.();

		expect(frames).toBe(3);
		expect(renders).toBe(3);
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
