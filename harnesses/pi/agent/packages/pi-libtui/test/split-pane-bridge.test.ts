import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	HStack,
	isFocusable,
	ScrollView,
	stripTerminalSequences,
	type TUI,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { installSplitPaneBridge } from "../src/host/split-pane-bridge.ts";
import { getMouseRegistryState } from "../src/mouse/registry.ts";
import type { LayoutBox, TuiMouseEvent } from "../src/mouse.ts";
import { ensureMouseRegistry } from "../src/mouse.ts";
import { ensureSplitPaneRegistry, type SplitPaneHost, type SplitPaneRegistry } from "../src/split-pane.ts";

// type-boundary: The bridge fixtures implement only the private renderer and theme surfaces used by this compatibility patch.
type TuiBoundary = unknown;
type ThemeBoundary = unknown;

const theme = {
	name: "test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[38;2;120;160;220m",
	getBgAnsi: () => "\x1b[48;2;20;24;30m",
} as ThemeBoundary as Theme;

function fill(label: string): Component {
	return {
		render: (width) => [label.repeat(width)],
		invalidate() {},
	};
}

class FullscreenTuiFixture {
	readonly mode = "fullscreen" as const;
	readonly terminal = { columns: 80, rows: 24 };
	layoutRoot: Component | undefined;
	currentLayout: object | undefined;
	renderRequests = 0;
	immediateRenderRequests = 0;
	private focusedComponent: Component | null = null;

	constructor(root?: Component) {
		this.layoutRoot = root;
	}

	setLayoutRoot(component: Component | undefined): void {
		if (this.layoutRoot === component) return;
		this.layoutRoot = component;
		this.currentLayout = undefined;
		this.requestRender();
	}

	requestRender(): void {
		this.renderRequests += 1;
	}

	requestImmediateRender(): void {
		this.immediateRenderRequests += 1;
	}

	getFocusedComponent(): Component | null {
		return this.focusedComponent;
	}

	setFocus(component: Component | null): void {
		if (isFocusable(this.focusedComponent)) this.focusedComponent.focused = false;
		this.focusedComponent = component;
		if (isFocusable(component)) component.focused = true;
	}
}

function registry(): SplitPaneRegistry {
	return ensureSplitPaneRegistry(Object.create(null) as typeof globalThis);
}

function mouseRegistry() {
	return ensureMouseRegistry(Object.create(null) as typeof globalThis);
}

function render(root: Component | undefined, width: number): string[] {
	if (!root) throw new Error("expected a layout root");
	return root.render(width).map(stripTerminalSequences);
}

// type-boundary: The test locates the host-owned divider in Pi TUI's structural layout entries.
type LayoutEntryBoundary = unknown;

function divider(root: Component | undefined): Component & { onMouse(event: TuiMouseEvent): boolean } {
	const entries = root && (Reflect.get(root as object, "entries") as LayoutEntryBoundary);
	if (!Array.isArray(entries)) throw new Error("expected split layout entries");
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const component = Reflect.get(entry, "component") as LayoutEntryBoundary;
		if (!component || typeof component !== "object") continue;
		if (typeof Reflect.get(component, "onMouse") === "function") {
			return component as Component & { onMouse(event: TuiMouseEvent): boolean };
		}
	}
	throw new Error("expected draggable split divider");
}

function splitEntries(root: Component | undefined): Component[] {
	const entries = root && (Reflect.get(root as object, "entries") as LayoutEntryBoundary);
	if (!Array.isArray(entries)) throw new Error("expected split layout entries");
	return entries.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const component = Reflect.get(entry, "component") as LayoutEntryBoundary;
		return component && typeof component === "object" ? [component as Component] : [];
	});
}

function layoutBox(component: Component, x: number, width: number, height: number, children: object[] = []) {
	const rect = { x, y: 0, width, height };
	return { component, rect, clip: rect, children };
}

function findScrollLayoutBox(box: LayoutBox, scrollView: ScrollView): LayoutBox | undefined {
	if (box.scrollView === scrollView) return box;
	for (const child of box.children) {
		const found = findScrollLayoutBox(child, scrollView);
		if (found) return found;
	}
	return undefined;
}

function mouse(type: TuiMouseEvent["type"], screenCol: number, button?: 0 | 1 | 2): TuiMouseEvent {
	return {
		type,
		row: 0,
		col: 0,
		screenRow: 0,
		screenCol,
		button,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

function focusable(label: string): Component & Focusable {
	return { ...fill(label), focused: false };
}

describe("split-pane bridge", () => {
	test("keeps contributed scroll views visible to fullscreen native selection", () => {
		const panes = registry();
		const side = new ScrollView(fill("P"), { overscroll: "contain" });
		const terminal = {
			columns: 80,
			rows: 24,
			kittyProtocolActive: false,
			start: () => {},
			stop: () => {},
			drainInput: async () => {},
			write: () => {},
			moveBy: () => {},
			hideCursor: () => {},
			showCursor: () => {},
			clearLine: () => {},
			clearFromCursor: () => {},
			clearScreen: () => {},
			setTitle: () => {},
			setProgress: () => {},
		};
		const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
		const removePane = panes.mount({
			id: "selectable",
			position: "right",
			component: () => side,
			size: 20,
			minMainSize: 1,
		});
		const removeBridge = installSplitPaneBridge(tui, () => theme, panes, mouseRegistry());
		tui.setLayoutRoot(new ScrollView(fill("M"), { primary: true }));
		tui.start();
		tui.renderNow(true);

		const layout = Reflect.get(tui, "currentLayout") as { root?: LayoutBox } | undefined;
		const sideBox = layout?.root ? findScrollLayoutBox(layout.root, side) : undefined;
		expect(sideBox?.scrollView).toBe(side);
		expect(sideBox?.scrollContentLines?.join("")).toContain("P");

		tui.stop();
		removeBridge();
		removePane();
	});

	test("adopts an existing root and allocates a real right-hand column", () => {
		const panes = registry();
		const main = fill("M");
		const tui = new FullscreenTuiFixture(main);
		const removePane = panes.mount({
			id: "right",
			position: "right",
			component: () => fill("P"),
			size: 20,
			minMainSize: 40,
			gap: 1,
		});
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());

		expect(tui.layoutRoot).toBeInstanceOf(HStack);
		expect(render(tui.layoutRoot, 80)[0]).toBe(`${"M".repeat(58)} │${"P".repeat(20)}`);
		expect(visibleWidth(render(tui.layoutRoot, 80)[0] ?? "")).toBe(80);

		removeBridge();
		expect(tui.layoutRoot).toBe(main);
		removePane();
	});

	test("derives an initial pane width from the terminal", () => {
		const panes = registry();
		const tui = new FullscreenTuiFixture(fill("M"));
		const removePane = panes.mount({
			id: "ratio",
			position: "right",
			component: () => fill("P"),
			size: 1,
			initialRatio: 0.4,
			minMainSize: 1,
			gap: 0,
		});
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());

		expect(render(tui.layoutRoot, 80)[0]).toBe(`${"M".repeat(47)}│${"P".repeat(32)}`);

		removeBridge();
		removePane();
	});

	test("supports left panes and restores the full main width below the visibility threshold", () => {
		const panes = registry();
		const main = fill("M");
		const tui = new FullscreenTuiFixture(main);
		const removePane = panes.mount({
			id: "left",
			position: "left",
			component: () => fill("P"),
			size: 20,
			minMainSize: 40,
			gap: 2,
		});
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());

		expect(render(tui.layoutRoot, 80)[0]).toBe(`${"P".repeat(20)}│  ${"M".repeat(57)}`);
		expect(render(tui.layoutRoot, 43)).toEqual(["M".repeat(43)]);
		expect(render(tui.layoutRoot, 44)[0]).toBe(`P│  ${"M".repeat(40)}`);

		removeBridge();
		removePane();
	});

	test("resizes from the visible border and clamps both pane and main widths", () => {
		const panes = registry();
		const tui = new FullscreenTuiFixture(fill("M"));
		const committedSizes: number[] = [];
		const removePane = panes.mount({
			id: "resizable",
			position: "right",
			component: () => fill("P"),
			size: 20,
			minMainSize: 40,
			gap: 1,
			onResize: (size) => committedSizes.push(size),
		});
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());
		const handle = divider(tui.layoutRoot);

		expect(Bun.stripANSI(handle.render(1)[0] ?? "")).toBe("│");
		tui.currentLayout = { stale: true };
		handle.onMouse(mouse("press", 59, 0));
		handle.onMouse(mouse("drag", 49, 0));
		handle.onMouse(mouse("release", 49, 0));
		expect(render(tui.layoutRoot, 80)[0]).toBe(`${"M".repeat(48)} │${"P".repeat(30)}`);
		expect(committedSizes).toEqual([30]);
		expect(tui.currentLayout).toBeUndefined();

		handle.onMouse(mouse("press", 49, 0));
		handle.onMouse(mouse("drag", 0, 0));
		handle.onMouse(mouse("release", 0, 0));
		expect(render(tui.layoutRoot, 80)[0]).toBe(`${"M".repeat(40)} │${"P".repeat(38)}`);
		expect(committedSizes).toEqual([30, 38]);

		handle.onMouse(mouse("press", 44, 0));
		handle.onMouse(mouse("drag", 79, 0));
		handle.onMouse(mouse("release", 79, 0));
		expect(render(tui.layoutRoot, 80)[0]).toBe(`${"M".repeat(77)} │P`);
		expect(tui.renderRequests).toBeGreaterThan(0);

		removeBridge();
		removePane();
	});

	test("restores each pane's preferred width after temporary replacement", () => {
		const panes = registry();
		const tui = new FullscreenTuiFixture(fill("M"));
		const removeFirst = panes.mount({
			id: "remembered",
			position: "right",
			component: () => fill("A"),
			size: 20,
			minMainSize: 40,
			gap: 1,
		});
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());
		const handle = divider(tui.layoutRoot);
		handle.onMouse(mouse("press", 59, 0));
		handle.onMouse(mouse("drag", 49, 0));
		handle.onMouse(mouse("release", 49, 0));

		const removeSecond = panes.mount({
			id: "temporary",
			position: "left",
			component: () => fill("B"),
			size: 12,
			minMainSize: 40,
		});
		expect(render(tui.layoutRoot, 80)[0]).toContain("B".repeat(12));
		removeSecond();
		expect(render(tui.layoutRoot, 80)[0]).toBe(`${"M".repeat(48)} │${"A".repeat(30)}`);

		removeBridge();
		removeFirst();
	});

	test("wraps future roots once and passes an undefined root through", () => {
		const panes = registry();
		const tui = new FullscreenTuiFixture();
		let created = 0;
		let disposed = 0;
		const removeCountedPane = panes.mount({
			id: "future",
			position: "right",
			component: () => {
				created += 1;
				return { ...fill("P"), dispose: () => (disposed += 1) };
			},
			size: 12,
			minMainSize: 30,
		});
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());
		const first = fill("A");

		tui.setLayoutRoot(first);
		const wrapper = tui.layoutRoot;
		expect(wrapper).toBeInstanceOf(HStack);
		tui.setLayoutRoot(wrapper);
		expect(tui.layoutRoot).toBe(wrapper);
		expect(created).toBe(1);

		tui.setLayoutRoot(undefined);
		expect(tui.layoutRoot).toBeUndefined();
		expect(disposed).toBe(1);

		removeBridge();
		removeCountedPane();
	});

	test("reacts to registry mount and unmount without replacing Pi's base root", () => {
		const panes = registry();
		const main = fill("M");
		const tui = new FullscreenTuiFixture(main);
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());
		expect(tui.layoutRoot).toBe(main);

		let disposed = 0;
		const removePane = panes.mount({
			id: "runtime",
			position: "right",
			component: () => ({ ...fill("P"), dispose: () => (disposed += 1) }),
			size: 16,
			minMainSize: 32,
		});
		expect(tui.layoutRoot).toBeInstanceOf(HStack);

		removePane();
		expect(tui.layoutRoot).toBe(main);
		expect(disposed).toBe(1);
		removeBridge();
	});

	test("keeps one pane and wrapper alive across overlapping bridge leases", () => {
		const panes = registry();
		const tui = new FullscreenTuiFixture(fill("M"));
		let created = 0;
		let disposed = 0;
		const removePane = panes.mount({
			id: "leased",
			position: "right",
			component: () => {
				created += 1;
				return { ...fill("P"), dispose: () => (disposed += 1) };
			},
			size: 16,
			minMainSize: 32,
		});
		const removeFirst = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());
		const wrapper = tui.layoutRoot;
		const patchedSetter = tui.setLayoutRoot;
		const removeSecond = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());

		expect(tui.layoutRoot).toBe(wrapper);
		expect(tui.setLayoutRoot).toBe(patchedSetter);
		expect(created).toBe(1);
		removeFirst();
		expect(tui.layoutRoot).toBe(wrapper);
		expect(disposed).toBe(0);
		removeSecond();
		expect(tui.layoutRoot).not.toBe(wrapper);
		expect(disposed).toBe(1);
		removePane();
	});

	test("uses the actual renderer behind Pi's stable proxy", () => {
		const panes = registry();
		const renderer = new FullscreenTuiFixture(fill("M"));
		let paneHost: SplitPaneHost | undefined;
		let created = 0;
		const removePane = panes.mount({
			id: "proxy",
			position: "right",
			component: (host) => {
				created += 1;
				paneHost = host;
				return fill("P");
			},
			size: 10,
			minMainSize: 30,
		});
		const proxy = new Proxy(renderer as TuiBoundary as TUI, {
			get(target, property) {
				const value = Reflect.get(target, property, target) as TuiBoundary;
				if (typeof value !== "function") return value;
				return (...args: never[]) => Reflect.apply(value, target, args);
			},
		});
		const removeBridge = installSplitPaneBridge(proxy, () => theme, panes, mouseRegistry());

		expect(renderer.layoutRoot).toBeInstanceOf(HStack);
		expect(created).toBe(1);
		expect(paneHost?.getTerminalSize()).toEqual({ columns: 80, rows: 24 });
		const previousRequests = renderer.renderRequests;
		paneHost?.requestRender();
		expect(renderer.renderRequests).toBe(previousRequests + 1);
		removeBridge();
		removePane();
	});

	test("forwards focus, input, and pointer events and restores captured focus", () => {
		const panes = registry();
		const main = focusable("M");
		const tui = new FullscreenTuiFixture(main);
		tui.setFocus(main);
		let paneHost: SplitPaneHost | undefined;
		const input: string[] = [];
		const pointer: TuiMouseEvent[] = [];
		const child = {
			...focusable("P"),
			handleInput: (data: string) => input.push(data),
			onMouse: (event: TuiMouseEvent) => {
				pointer.push(event);
				return true;
			},
		};
		const removePane = panes.mount({
			id: "interactive",
			position: "right",
			component: (host) => {
				paneHost = host;
				return child;
			},
			size: 20,
			minMainSize: 1,
		});
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());

		expect(paneHost?.tui as TuiBoundary).toBe(tui);
		expect(paneHost?.isFocused()).toBe(false);
		paneHost?.focus();
		expect(paneHost?.isFocused()).toBe(true);
		expect(main.focused).toBe(false);
		expect(child.focused).toBe(true);
		const focused = tui.getFocusedComponent();
		focused?.handleInput?.("hello");
		expect(input).toEqual(["hello"]);
		expect((focused as Component & { onMouse(event: TuiMouseEvent): boolean }).onMouse(mouse("press", 70, 0))).toBe(
			true,
		);
		expect(pointer).toHaveLength(1);

		paneHost?.blur();
		expect(tui.getFocusedComponent()).toBe(main);
		expect(main.focused).toBe(true);
		expect(child.focused).toBe(false);
		removeBridge();
		removePane();
	});

	test("defers only the redundant host frame for asynchronous pane input", async () => {
		const panes = registry();
		const tui = new FullscreenTuiFixture(fill("M"));
		const removePane = panes.mount({
			id: "input-render",
			position: "right",
			component: () => ({ ...focusable("P"), defersInputRender: () => true, handleInput() {} }),
			size: 20,
			minMainSize: 1,
		});
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());
		const pane = splitEntries(tui.layoutRoot).at(-1);
		if (!pane) throw new Error("expected pane");

		pane.handleInput?.("a");
		tui.requestImmediateRender();
		expect(tui.immediateRenderRequests).toBe(0);
		await Promise.resolve();
		tui.requestImmediateRender();
		expect(tui.immediateRenderRequests).toBe(1);

		removeBridge();
		removePane();
	});

	test("reports the allocated pane viewport height so cursor-bearing children keep their first rows", () => {
		const panes = registry();
		const tui = new FullscreenTuiFixture(fill("M"));
		const observedRows: number[] = [];
		const removePane = panes.mount({
			id: "short-viewport",
			position: "right",
			component: (host) => ({
				render: () => {
					const rows = host.getTerminalSize().rows;
					observedRows.push(rows);
					return ["HEADER", ...Array.from({ length: Math.max(0, rows - 2) }, () => "body"), "INPUT"];
				},
				invalidate() {},
			}),
			size: 20,
			minMainSize: 1,
		});
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());
		const root = tui.layoutRoot;
		if (!root) throw new Error("expected split root");
		const [main, spacer, separator, pane] = splitEntries(root);
		if (!main || !spacer || !separator || !pane) throw new Error("expected right split entries");
		tui.currentLayout = {
			root: layoutBox(root, 0, 80, 6, [
				layoutBox(main, 0, 58, 6),
				layoutBox(spacer, 58, 1, 6),
				layoutBox(separator, 59, 1, 6),
				layoutBox(pane, 60, 20, 6),
			]),
		};

		const lines = pane.render(20);
		expect(observedRows.at(-1)).toBe(6);
		expect(lines).toHaveLength(6);
		expect(lines[0]).toBe("HEADER");
		expect(lines.at(-1)).toBe("INPUT");

		removeBridge();
		removePane();
	});

	test("clicking either pane moves focus without consuming native or component mouse handling", () => {
		const panes = registry();
		const pointerRegistry = mouseRegistry();
		const main = focusable("M");
		const tui = new FullscreenTuiFixture(main);
		tui.setFocus(main);
		let paneHost: SplitPaneHost | undefined;
		const removePane = panes.mount({
			id: "click-focus",
			position: "right",
			component: (host) => {
				paneHost = host;
				return focusable("P");
			},
			size: 20,
			minMainSize: 1,
		});
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, pointerRegistry);
		const root = tui.layoutRoot;
		if (!root) throw new Error("expected split root");
		const [mainEntry, spacer, separator, pane] = splitEntries(root);
		if (!mainEntry || !spacer || !separator || !pane) throw new Error("expected right split entries");
		tui.currentLayout = {
			root: layoutBox(root, 0, 80, 24, [
				layoutBox(mainEntry, 0, 58, 24),
				layoutBox(spacer, 58, 1, 24),
				layoutBox(separator, 59, 1, 24),
				layoutBox(pane, 60, 20, 24),
			]),
		};
		paneHost?.focus();
		expect(paneHost?.isFocused()).toBe(true);

		const region = getMouseRegistryState(pointerRegistry).regions.find(
			(candidate) => candidate.id === "pi-libtui.split-pane.main-focus",
		);
		expect(region?.getRect()).toEqual({ x: 0, y: 0, width: 58, height: 24 });
		expect(region?.onMouse(mouse("press", 20, 0))).toBe(false);
		expect(tui.getFocusedComponent()).toBe(main);
		const mainRect = region?.getRect();
		expect(mainRect ? mainRect.x + mainRect.width <= 60 : false).toBe(true);

		const paneRegion = getMouseRegistryState(pointerRegistry).regions.find(
			(candidate) => candidate.id === "pi-libtui.split-pane.pane-focus",
		);
		expect(paneRegion?.getRect()).toEqual({ x: 60, y: 0, width: 20, height: 24 });
		expect(paneRegion?.onMouse(mouse("press", 70, 0))).toBe(false);
		expect(paneHost?.isFocused()).toBe(true);

		removeBridge();
		expect(getMouseRegistryState(pointerRegistry).regions).toEqual([]);
		removePane();
	});

	test("lets an empty pane decline keyboard focus while keeping its pointer surface mounted", () => {
		const panes = registry();
		const pointerRegistry = mouseRegistry();
		const main = focusable("M");
		const tui = new FullscreenTuiFixture(main);
		tui.setFocus(main);
		let paneHost: SplitPaneHost | undefined;
		const removePane = panes.mount({
			id: "non-focusable-empty",
			position: "right",
			component: (host) => {
				paneHost = host;
				return { ...focusable("P"), acceptsFocus: () => false };
			},
			size: 20,
			minMainSize: 1,
		});
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, pointerRegistry);

		paneHost?.focus();
		expect(paneHost?.isFocused()).toBe(false);
		expect(tui.getFocusedComponent()).toBe(main);

		removeBridge();
		removePane();
	});

	test("does not steal focus back after another component takes it", () => {
		const panes = registry();
		const main = focusable("M");
		const overlay = focusable("O");
		const tui = new FullscreenTuiFixture(main);
		tui.setFocus(main);
		let paneHost: SplitPaneHost | undefined;
		const removePane = panes.mount({
			id: "focus-owner",
			position: "right",
			component: (host) => {
				paneHost = host;
				return focusable("P");
			},
			size: 20,
			minMainSize: 1,
		});
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());

		paneHost?.focus();
		tui.setFocus(overlay);
		paneHost?.blur();
		removePane();
		expect(tui.getFocusedComponent()).toBe(overlay);

		removeBridge();
	});

	test("transfers pane focus across fullscreen renderers and retains the main restore target", () => {
		const panes = registry();
		const main = focusable("M");
		const first = new FullscreenTuiFixture(main);
		first.setFocus(main);
		const hosts: SplitPaneHost[] = [];
		const removePane = panes.mount({
			id: "mode-transfer",
			position: "right",
			component: (host) => {
				hosts.push(host);
				return focusable("P");
			},
			size: 20,
			minMainSize: 1,
		});
		const removeBridge = installSplitPaneBridge(first as TuiBoundary as TUI, () => theme, panes, mouseRegistry());
		hosts[0]?.focus();
		const oldPane = first.getFocusedComponent();
		if (!oldPane) throw new Error("expected focused first pane");

		const second = new FullscreenTuiFixture();
		second.setFocus(oldPane);
		second.setLayoutRoot(main);
		expect(hosts).toHaveLength(2);
		expect(hosts[1]?.isFocused()).toBe(true);
		expect(second.getFocusedComponent()).not.toBe(oldPane);

		hosts[1]?.blur();
		expect(second.getFocusedComponent()).toBe(main);
		removeBridge();
		removePane();
	});

	test("keeps the current pane alive when replacement setup fails", () => {
		const panes = registry();
		const tui = new FullscreenTuiFixture(fill("M"));
		let firstDisposed = 0;
		let themeFails = false;
		const removeFirst = panes.mount({
			id: "first",
			position: "right",
			component: () => ({ ...fill("A"), dispose: () => (firstDisposed += 1) }),
			size: 10,
			minMainSize: 30,
		});
		const removeBridge = installSplitPaneBridge(
			tui as TuiBoundary as TUI,
			() => {
				if (themeFails) throw new Error("theme unavailable");
				return theme;
			},
			panes,
			mouseRegistry(),
		);
		const firstRoot = tui.layoutRoot;
		themeFails = true;
		const removeSecond = panes.mount({
			id: "second",
			position: "right",
			component: () => fill("B"),
			size: 10,
			minMainSize: 30,
		});

		expect(tui.layoutRoot).toBe(firstRoot);
		expect(firstDisposed).toBe(0);
		themeFails = false;
		removeSecond();
		expect(tui.layoutRoot).toBe(firstRoot);
		expect(firstDisposed).toBe(0);
		removeBridge();
		expect(firstDisposed).toBe(1);
		removeFirst();
	});

	test("patches future fullscreen renderers when installed from regular mode", () => {
		const panes = registry();
		const removePane = panes.mount({
			id: "mode-switch",
			position: "right",
			component: () => fill("P"),
			size: 10,
			minMainSize: 30,
		});
		const regular = { mode: "regular" } as TuiBoundary as TUI;
		const original = TuiAltScreen.prototype.setLayoutRoot;
		const removeBridge = installSplitPaneBridge(regular, () => theme, panes, mouseRegistry());
		const future = new FullscreenTuiFixture();

		Reflect.apply(TuiAltScreen.prototype.setLayoutRoot, future, [fill("M")]);
		expect(future.layoutRoot).toBeInstanceOf(HStack);
		removeBridge();
		expect(TuiAltScreen.prototype.setLayoutRoot).toBe(original);
		removePane();
	});

	test("preserves foreign root and method replacements during cleanup", () => {
		const panes = registry();
		const tui = new FullscreenTuiFixture(fill("M"));
		const removePane = panes.mount({
			id: "foreign",
			position: "right",
			component: () => fill("P"),
			size: 10,
			minMainSize: 30,
		});
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());
		const foreignRoot = fill("F");
		const originalSetter = FullscreenTuiFixture.prototype.setLayoutRoot;
		const foreignSetter = function (this: FullscreenTuiFixture, root: Component | undefined): void {
			this.layoutRoot = root;
		};
		tui.layoutRoot = foreignRoot;
		FullscreenTuiFixture.prototype.setLayoutRoot = foreignSetter;

		removeBridge();
		expect(tui.layoutRoot).toBe(foreignRoot);
		expect(FullscreenTuiFixture.prototype.setLayoutRoot).toBe(foreignSetter);
		FullscreenTuiFixture.prototype.setLayoutRoot = originalSetter;
		removePane();
	});

	test("a delegating foreign setter cannot reactivate a released bridge", () => {
		const panes = registry();
		const main = fill("M");
		const tui = new FullscreenTuiFixture(main);
		let created = 0;
		let disposed = 0;
		const removePane = panes.mount({
			id: "released",
			position: "right",
			component: () => {
				created += 1;
				return { ...fill("P"), dispose: () => (disposed += 1) };
			},
			size: 10,
			minMainSize: 30,
		});
		const originalSetter = FullscreenTuiFixture.prototype.setLayoutRoot;
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());
		const patchedSetter = FullscreenTuiFixture.prototype.setLayoutRoot;
		const foreignSetter = function (this: FullscreenTuiFixture, root: Component | undefined): void {
			Reflect.apply(patchedSetter, this, [root]);
		};
		FullscreenTuiFixture.prototype.setLayoutRoot = foreignSetter;

		try {
			removeBridge();
			expect(tui.layoutRoot).toBe(main);
			expect(disposed).toBe(1);
			const replacement = fill("R");
			tui.setLayoutRoot(replacement);
			expect(tui.layoutRoot).toBe(replacement);
			expect(created).toBe(1);
		} finally {
			FullscreenTuiFixture.prototype.setLayoutRoot = originalSetter;
			removePane();
		}
	});

	test("contains component factory, render, invalidation, and disposal failures", () => {
		const panes = registry();
		const main = focusable("M");
		const tui = new FullscreenTuiFixture(main);
		tui.setFocus(main);
		const removeThrowingFactory = panes.mount({
			id: "throwing-factory",
			position: "right",
			component: () => {
				throw new Error("factory failed");
			},
			size: 10,
			minMainSize: 30,
		});
		const removeBridge = installSplitPaneBridge(tui as TuiBoundary as TUI, () => theme, panes, mouseRegistry());
		expect(() => render(tui.layoutRoot, 80)).not.toThrow();

		removeThrowingFactory();
		let brokenHost: SplitPaneHost | undefined;
		const removeBrokenPane = panes.mount({
			id: "broken-component",
			position: "right",
			component: (host) => {
				brokenHost = host;
				return {
					get focused() {
						return false;
					},
					set focused(_value: boolean) {
						throw new Error("focus failed");
					},
					render: () => {
						throw new Error("render failed");
					},
					handleInput: () => {
						throw new Error("input failed");
					},
					onMouse: () => {
						throw new Error("mouse failed");
					},
					invalidate: () => {
						throw new Error("invalidate failed");
					},
					dispose: () => {
						throw new Error("dispose failed");
					},
				};
			},
			size: 10,
			minMainSize: 30,
		});
		const wrapper = tui.layoutRoot;
		expect(() => render(wrapper, 80)).not.toThrow();
		expect(() => wrapper?.invalidate()).not.toThrow();
		expect(() => brokenHost?.focus()).not.toThrow();
		const focused = tui.getFocusedComponent();
		expect(() => focused?.handleInput?.("x")).not.toThrow();
		expect(() =>
			(focused as Component & { onMouse(event: TuiMouseEvent): boolean }).onMouse(mouse("press", 70, 0)),
		).not.toThrow();
		expect(() => brokenHost?.blur()).not.toThrow();
		expect(() => removeBrokenPane()).not.toThrow();
		expect(() => removeBridge()).not.toThrow();
	});
});
