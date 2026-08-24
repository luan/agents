import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Spacer,
	type TUI,
	TuiAltScreen,
	type TuiInputListenerResult,
} from "@earendil-works/pi-tui";
import { tuiTheme } from "../../src/color/theme.ts";
import { ComponentStack } from "../../src/component-stack.ts";
import { parseUnifiedDiff, UnifiedDiffView } from "../../src/diff/index.ts";
import {
	installAllMotionTracking,
	installMouseBridge,
	isPiMultiplexedEnvironment,
} from "../../src/host/mouse-bridge.ts";
import { getMouseRegistryState } from "../../src/mouse/registry.ts";
import {
	ensureMouseRegistry,
	FULLSCREEN_LAYOUT_CAPABILITY_KEY,
	getFullscreenLayoutCapability,
	resolveFullscreenLayout,
	type TuiMouseEvent,
} from "../../src/mouse.ts";
import { ensureSelectionRegistry, type NativeSelectionCompleted } from "../../src/selection.ts";
import { ToolDisclosureAction } from "../../src/tool/disclosure-action.ts";
import { ToolOutput } from "../../src/tool/output.ts";
import { ToolViewRegion } from "../../src/tool/view-region.ts";

type TestHandler = (event: TuiMouseEvent) => boolean;

class TestComponent implements Component {
	readonly events: TuiMouseEvent[] = [];
	private readonly handler: TestHandler;

	constructor(handler: TestHandler = () => false) {
		this.handler = handler;
	}

	render(): string[] {
		return ["test"];
	}

	invalidate(): void {}

	onMouse(event: TuiMouseEvent): boolean {
		this.events.push(event);
		return this.handler(event);
	}
}

class LinesComponent implements Component {
	constructor(private readonly lines: string[]) {}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class RenderCountingComponent implements Component {
	renders = 0;

	render(): string[] {
		this.renders += 1;
		return ["expensive transcript"];
	}

	invalidate(): void {}
}

class RenderCountingMouseComponent extends TestComponent {
	renders = 0;

	override render(): string[] {
		this.renders += 1;
		return ["target"];
	}
}

interface TestBox {
	component: Component;
	rect: { x: number; y: number; width: number; height: number };
	clip: { x: number; y: number; width: number; height: number };
	children: TestBox[];
	scrollView?: object;
	scrollContentLines?: readonly string[];
}

interface TestTui {
	mode: "fullscreen" | "regular";
	currentLayout?: { root: TestBox; primaryScrollView?: object };
	handleViewportInput(data: string): TuiInputListenerResult;
	requestRender(): void;
	shouldDeferViewportInputToOverlay?(): boolean;
	getTopmostVisibleOverlay?(): object;
	resolveOverlayLayout?(
		options: object | undefined,
		height: number,
		width: number,
		rows: number,
	): {
		width: number;
		row: number;
		col: number;
		maxHeight?: number;
	};
	nativeInputs: string[];
	renders: number;
	selectionPressActive?: boolean;
	selectionAnchor?: object;
	selectionFocus?: object;
	selectionGranularity?: string;
	mouseEnabled?: boolean;
	copySelectionToClipboard?(): void;
	terminal: { rows: number; columns: number; writes: string[]; write(data: string): void };
}

type TestTuiPrototype = Pick<TestTui, "handleViewportInput" | "requestRender">;

// type-boundary: Object.setPrototypeOf supplies the two TestTui methods immediately after construction.
type IncompleteTestTui = unknown;

// type-boundary: TestTui implements the renderer members exercised by installMouseBridge.
type TestTuiBoundary = unknown;

function box(component: Component, children: TestBox[] = [], x = 0, y = 0, width = 20, height = 10): TestBox {
	return {
		component,
		rect: { x, y, width, height },
		clip: { x, y, width, height },
		children,
	};
}

function createPrototype(): TestTuiPrototype {
	return {
		handleViewportInput(this: TestTui, data) {
			this.nativeInputs.push(data);
			return { data: `native:${data}` };
		},
		requestRender(this: TestTui) {
			this.renders += 1;
		},
	};
}

function createTui(root?: TestBox, prototype: TestTuiPrototype = createPrototype()): TestTui {
	const incomplete: IncompleteTestTui = {
		mode: "fullscreen",
		currentLayout: root ? { root } : undefined,
		nativeInputs: [],
		renders: 0,
		mouseEnabled: true,
		terminal: {
			rows: 24,
			columns: 80,
			writes: [] as string[],
			write(data: string) {
				this.writes.push(data);
			},
		},
	};
	const tui = incomplete as TestTui;
	Object.setPrototypeOf(tui, prototype);
	return tui;
}

function createTranscriptTui(): {
	tui: TestTui;
	scrollView: { scrollTop: number; viewportHeight: number; scrollTo(row: number): void };
} {
	const scrollView = {
		scrollTop: 2,
		viewportHeight: 2,
		scrollTo(row: number) {
			this.scrollTop = row;
		},
	};
	const content = new LinesComponent(["zero", "one", "two", "three"]);
	const contentBox = box(content, [], 0, -2, 20, 4);
	const primaryBox = box(new LinesComponent([]), [contentBox], 0, 0, 20, 2);
	primaryBox.scrollView = scrollView;
	primaryBox.scrollContentLines = ["zero", "one", "two", "three"];
	const root = box(new LinesComponent([]), [primaryBox], 0, 0, 20, 2);
	const tui = createTui(root);
	tui.currentLayout = { root, primaryScrollView: scrollView };
	return { tui, scrollView };
}

function input(tui: TestTui, data: string): TuiInputListenerResult {
	return tui.handleViewportInput(data);
}

function registry() {
	return ensureMouseRegistry(Object.create(null) as typeof globalThis);
}

function asTui(tui: TestTui): TUI {
	const boundary: TestTuiBoundary = tui;
	return boundary as TUI;
}

const theme = {
	name: "bridge",
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[39m",
	getBgAnsi: () => "\x1b[49m",
	bold: (text: string) => text,
} as never as Theme;

function viewRegion(
	options: { initialMode?: "preview" | "full"; component?: Component; onModeChange?(mode: string): void } = {},
): ToolViewRegion {
	const component = options.component ?? new LinesComponent(["body"]);
	return new ToolViewRegion({
		theme,
		initialMode: options.initialMode,
		requestRender() {},
		onModeChange: options.onModeChange,
		modes: [
			{ id: "preview", component: new LinesComponent([]), nextHint: "expand", activate: "full" },
			{ id: "full", component, nextHint: "collapse", activate: "preview" },
		],
	});
}

function disclosureLayout(action: ToolDisclosureAction, region: ToolViewRegion): TestBox {
	const stack = new ComponentStack([action, region]);
	const lines = stack.render(20);
	const children = stack.getSpans().map((span) => box(span.component, [], 0, span.row, span.width, span.height));
	return box(stack, children, 0, 0, 20, lines.length);
}

function disclosureComponents(): { action: ToolDisclosureAction; region: ToolViewRegion } {
	const output = new ToolOutput({
		theme,
		viewport: { maxRows: 3, selection: "head-tail" },
	});
	output.replace({ text: "first\nsecond\nthird\nfourth", revision: 1 });
	const region = new ToolViewRegion({
		theme,
		requestRender() {},
		modes: [
			{ id: "preview", component: output, activationRow: "omission", activate: "full" },
			{ id: "full", component: output, activate: "preview" },
		],
	});
	return {
		region,
		action: new ToolDisclosureAction(theme, new LinesComponent(["action"]), region, () => {}),
	};
}

function diffDisclosureComponents(): {
	action: ToolDisclosureAction;
	region: ToolViewRegion;
	view: UnifiedDiffView;
} {
	const view = new UnifiedDiffView({
		theme: tuiTheme(theme),
		model: parseUnifiedDiff(
			["--- a/x", "+++ b/x", "@@ -1,5 +1,5 @@", " one", " two", " three", " four", " five"].join("\n"),
		),
		viewport: { maxRows: 3, selection: "head-tail" },
	});
	const region = new ToolViewRegion({
		theme,
		requestRender() {},
		modes: [
			{ id: "preview", component: view, activationRow: "omission", activate: "full" },
			{ id: "full", component: view, activate: "preview" },
		],
	});
	return {
		region,
		view,
		action: new ToolDisclosureAction(theme, new LinesComponent(["action"]), region, () => {}),
	};
}

describe("mouse bridge", () => {
	test("registers ComponentStack rows as independent hover targets", () => {
		const rows = [new TestComponent(() => true), new TestComponent(() => true), new TestComponent(() => true)];
		const stack = new ComponentStack(rows);
		stack.render(20);
		const tui = createTui(box(stack, [], 0, 0, 20, rows.length));
		const dispose = installMouseBridge(asTui(tui), registry());

		expect(input(tui, "\x1b[<35;1;1M")).toEqual({ consume: true });
		expect(input(tui, "\x1b[<35;1;2M")).toEqual({ consume: true });
		expect(input(tui, "\x1b[<35;1;3M")).toEqual({ consume: true });
		expect(tui.renders).toBe(3);
		expect(rows.map((row) => row.events.map((event) => event.type))).toEqual([
			["enter", "leave"],
			["enter", "leave"],
			["enter"],
		]);
		dispose();
	});

	test("keeps view-mode clicks selection-safe and routes keys after viewport handlers", () => {
		let expandedChanges = 0;
		const region = viewRegion({ onModeChange: () => expandedChanges++ });
		region.render(20);
		const prototype = createPrototype();
		prototype.handleViewportInput = function (this: TestTui, data) {
			this.nativeInputs.push(data);
			if (data.endsWith("M") && data.startsWith("\x1b[<0;")) this.selectionPressActive = true;
			if (data.endsWith("m")) this.selectionPressActive = false;
			return { data: `native:${data}` };
		};
		const tui = createTui(box(region, [], 0, 0, 20, 2), prototype);
		const mouseRegistry = registry();
		let modalKeys = 0;
		let overlayPresses = 0;
		mouseRegistry.registerOverlayRegion({
			id: "copy-mode-cursor",
			priority: 1_000,
			getRect: () => ({ x: 0, y: 0, width: 20, height: 2 }),
			onMouse(event) {
				if (event.type === "press") overlayPresses++;
				return false;
			},
		});
		mouseRegistry.registerViewportInputHandler({
			id: "copy-mode",
			priority: 1_000,
			handle(data) {
				if (data !== "modal") return undefined;
				modalKeys++;
				return { consume: true };
			},
		});
		const dispose = installMouseBridge(asTui(tui), mouseRegistry);

		expect(input(tui, "\x1b[<0;2;1M")).toEqual({ data: "native:\x1b[<0;2;1M" });
		expect(input(tui, "\x1b[<0;2;1m")).toEqual({ data: "native:\x1b[<0;2;1m" });
		expect(region.getMode()).toBe("full");
		expect(overlayPresses).toBe(1);
		expect(input(tui, "modal")).toEqual({ consume: true, data: "modal" });
		expect(modalKeys).toBe(1);
		expect(region.getMode()).toBe("full");
		// Enter only activates a folded region. Expanded content leaves the key
		// available to the native viewport handler, just like an expanded primary
		// click leaves the region open.
		expect(input(tui, "\r")).toEqual({ data: "native:\r" });
		expect(region.getMode()).toBe("full");

		input(tui, "\x1b[<0;2;1M");
		input(tui, "\x1b[<32;6;1M");
		input(tui, "\x1b[<0;6;1m");
		expect(region.getMode()).toBe("full");
		expect(expandedChanges).toBe(1);
		expect(overlayPresses).toBe(2);
		expect(tui.nativeInputs.filter((data) => data.startsWith("\x1b[<"))).toHaveLength(5);

		tui.currentLayout = undefined;
		expect(input(tui, "\r")).toEqual({ data: "native:\r" });
		dispose();
	});

	test("passes unsupported mouse packets directly to native input", () => {
		const tui = createTui(box(new TestComponent(() => false)));
		const mouseRegistry = registry();
		const viewportInputs: string[] = [];
		mouseRegistry.registerViewportInputHandler({
			id: "keyboard-owner",
			handle(data) {
				viewportInputs.push(data);
				return { consume: true };
			},
		});
		const dispose = installMouseBridge(asTui(tui), mouseRegistry);
		const unsupportedSgrWheel = "\x1b[<66;2;1M";
		const unsupportedX10Press = "\x1b[M !!";

		expect(input(tui, unsupportedSgrWheel)).toEqual({ data: `native:${unsupportedSgrWheel}` });
		expect(input(tui, unsupportedX10Press)).toEqual({ data: `native:${unsupportedX10Press}` });
		expect(viewportInputs).toEqual([]);
		dispose();
	});

	test("routes omission, disclosure header, and expanded body through current layout boxes", () => {
		const { action, region } = disclosureComponents();
		const prototype = createPrototype();
		prototype.handleViewportInput = function (this: TestTui, data) {
			this.nativeInputs.push(data);
			if (data.endsWith("M") && data.startsWith("\x1b[<0;")) this.selectionPressActive = true;
			if (data.endsWith("m")) this.selectionPressActive = false;
			return { data: `native:${data}` };
		};
		const tui = createTui(disclosureLayout(action, region), prototype);
		const dispose = installMouseBridge(asTui(tui), registry());

		// The current preview puts its activation control on the middle omission row:
		// action y=0, preview rows y=1..3, omission y=2 (terminal coordinates are +1).
		expect(input(tui, "\x1b[<0;2;3M")).toEqual({ data: "native:\x1b[<0;2;3M" });
		expect(input(tui, "\x1b[<0;2;3m")).toEqual({ data: "native:\x1b[<0;2;3m" });
		expect(region.getMode()).toBe("full");

		// A stale release after the header press cannot dispatch through the old action box.
		tui.currentLayout = { root: disclosureLayout(action, region) };
		expect(input(tui, "\x1b[<0;2;1M")).toEqual({ data: "native:\x1b[<0;2;1M" });
		tui.currentLayout = { root: box(new LinesComponent(["replacement"]), [], 0, 0, 20, 1) };
		expect(input(tui, "\x1b[<0;2;1m")).toEqual({ data: "native:\x1b[<0;2;1m" });
		expect(region.getMode()).toBe("full");

		// With the real action row present, an expanded primary header click folds.
		tui.currentLayout = { root: disclosureLayout(action, region) };
		expect(input(tui, "\x1b[<0;2;1M")).toEqual({ data: "native:\x1b[<0;2;1M" });
		expect(input(tui, "\x1b[<0;2;1m")).toEqual({ data: "native:\x1b[<0;2;1m" });
		expect(region.getMode()).toBe("preview");

		// Re-open through the omission row, then leave an expanded body primary gesture to native selection.
		tui.currentLayout = { root: disclosureLayout(action, region) };
		input(tui, "\x1b[<0;2;3M");
		input(tui, "\x1b[<0;2;3m");
		expect(region.getMode()).toBe("full");
		tui.currentLayout = { root: disclosureLayout(action, region) };
		expect(input(tui, "\x1b[<0;2;2M")).toEqual({ data: "native:\x1b[<0;2;2M" });
		tui.currentLayout = { root: box(new LinesComponent(["replacement"]), [], 0, 0, 20, 1) };
		expect(input(tui, "\x1b[<0;2;2m")).toEqual({ data: "native:\x1b[<0;2;2m" });
		expect(region.getMode()).toBe("full");

		tui.currentLayout = { root: disclosureLayout(action, region) };
		expect(input(tui, "\x1b[<2;2;1M")).toEqual({ consume: true });
		expect(input(tui, "\x1b[<2;2;1m")).toEqual({ consume: true });
		expect(region.getMode()).toBe("preview");
		dispose();
	});

	test("routes diff omission hover across its gutter and body", () => {
		const { action, region, view } = diffDisclosureComponents();
		const root = disclosureLayout(action, region);
		const tui = createTui(root);
		const dispose = installMouseBridge(asTui(tui), registry());
		const colors = tuiTheme(theme);
		const omissionRow = view.getOmissionRow();
		expect(omissionRow).toBeDefined();
		const collapsed = region.render(20);
		expect(collapsed[omissionRow!]).toContain(colors.bgAnsi("diff.hunk"));
		expect(collapsed[omissionRow!]).toContain(colors.bgAnsi("diff.hunkGutter"));

		// The action occupies screen row 0, so the omission is one-based at row + 2.
		const screenRow = omissionRow! + 2;
		expect(input(tui, `\x1b[<35;1;${screenRow}M`)).toEqual({ consume: true });
		const gutterHovered = region.render(20)[omissionRow!];
		expect(gutterHovered).toContain(colors.bgAnsi("diff.hunkHover"));
		expect(gutterHovered).toContain(colors.bgAnsi("diff.hunkGutterHover"));

		// Move outside the transcript, then back over the last body cell of the same row.
		input(tui, `\x1b[<35;21;${screenRow}M`);
		expect(input(tui, `\x1b[<35;20;${screenRow}M`)).toEqual({ consume: true });
		const bodyHovered = region.render(20)[omissionRow!];
		expect(bodyHovered).toContain(colors.bgAnsi("diff.hunkHover"));
		expect(bodyHovered).toContain(colors.bgAnsi("diff.hunkGutterHover"));

		input(tui, `\x1b[<35;21;${screenRow}M`);
		expect(region.render(20)[omissionRow!]).toEqual(collapsed[omissionRow!]);
		region.dispose();
		dispose();
	});

	test("clears transcript keyboard focus for overlays, Escape, and clipped targets", () => {
		const disclosure = viewRegion();
		disclosure.render(20);
		const prototype = createPrototype();
		prototype.handleViewportInput = function (this: TestTui, data) {
			this.nativeInputs.push(data);
			if (data.endsWith("M") && data.startsWith("\x1b[<0;")) this.selectionPressActive = true;
			if (data.endsWith("m")) this.selectionPressActive = false;
			return { data: `native:${data}` };
		};
		const root = box(disclosure, [], 0, 0, 20, 2);
		const tui = createTui(root, prototype);
		const dispose = installMouseBridge(asTui(tui), registry());
		const clickRegion = () => {
			input(tui, "\x1b[<0;2;1M");
			input(tui, "\x1b[<0;2;1m");
		};

		clickRegion();
		expect(disclosure.getMode()).toBe("full");
		tui.shouldDeferViewportInputToOverlay = () => true;
		expect(input(tui, "\r")).toEqual({ data: "native:\r" });
		expect(disclosure.getMode()).toBe("full");
		tui.shouldDeferViewportInputToOverlay = () => false;
		expect(input(tui, "\r")).toEqual({ data: "native:\r" });

		clickRegion();
		// A primary click in expanded content must not collapse the region.
		expect(disclosure.getMode()).toBe("full");
		expect(input(tui, "\x1b")).toEqual({ data: "native:\x1b" });
		expect(input(tui, "\r")).toEqual({ data: "native:\r" });

		// Secondary body clicks fold without claiming primary selection gestures.
		expect(input(tui, "\x1b[<2;2;1M")).toEqual({ consume: true });
		expect(input(tui, "\x1b[<2;2;1m")).toEqual({ consume: true });
		expect(disclosure.getMode()).toBe("preview");
		root.clip.height = 0;
		expect(input(tui, "\r")).toEqual({ data: "native:\r" });
		expect(disclosure.getMode()).toBe("preview");
		dispose();
	});

	test("dispatches innermost first and delegates when no component handles", () => {
		const order: string[] = [];
		const child = new TestComponent(() => {
			order.push("child");
			return false;
		});
		const parent = new TestComponent(() => {
			order.push("parent");
			return true;
		});
		const tui = createTui(box(parent, [box(child, [], 2, 2, 5, 3)]));
		const dispose = installMouseBridge(asTui(tui), registry());

		expect(input(tui, "\x1b[<0;4;4M")).toEqual({ consume: true });
		expect(order).toEqual(["child", "parent"]);
		expect(parent.events[0]).toMatchObject({ type: "press", row: 3, col: 3, button: 0 });

		expect(input(tui, "ordinary-key")).toEqual({ data: "native:ordinary-key" });
		expect(tui.nativeInputs).toEqual(["ordinary-key"]);
		dispose();
	});

	test("dispatches viewport keyboard handlers after mouse parsing and before Pi keybindings", () => {
		const tui = createTui();
		const mouseRegistry = registry();
		const handled: string[] = [];
		mouseRegistry.registerViewportInputHandler({
			id: "transform",
			priority: 10,
			handle(data) {
				handled.push(data);
				return data === "a" ? { data: "b" } : data === "consume" ? { consume: true } : undefined;
			},
		});
		const dispose = installMouseBridge(asTui(tui), mouseRegistry);

		expect(input(tui, "a")).toEqual({ data: "native:b" });
		expect(input(tui, "consume")).toEqual({ consume: true, data: "consume" });
		input(tui, "\x1b[I");
		input(tui, "\x1b[O");
		input(tui, "\x1b[<0;2;1M");
		expect(handled).toEqual(["a", "consume"]);
		expect(tui.nativeInputs).toEqual(["b", "\x1b[I", "\x1b[O", "\x1b[<0;2;1M"]);
		dispose();
	});

	test("respects clips and isolates a throwing callback", () => {
		const throwing = new TestComponent(() => {
			throw new Error("broken component");
		});
		const parent = new TestComponent(() => false);
		const clipped = box(throwing, [], 2, 2, 5, 3);
		clipped.clip = { x: 10, y: 10, width: 1, height: 1 };
		const tui = createTui(box(parent, [clipped]));
		const dispose = installMouseBridge(asTui(tui), registry());

		expect(input(tui, "\x1b[<0;4;4M")).toEqual({ data: "native:\x1b[<0;4;4M" });
		expect(throwing.events).toHaveLength(0);
		expect(parent.events).toHaveLength(1);

		clipped.clip = clipped.rect;
		expect(() => input(tui, "\x1b[<0;4;4M")).not.toThrow();
		expect(tui.nativeInputs).toHaveLength(2);
		dispose();
	});

	test("captures drag and release after a handled press", () => {
		const component = new TestComponent(() => true);
		const tui = createTui(box(component, [], 0, 0, 5, 2));
		const dispose = installMouseBridge(asTui(tui), registry());

		expect(input(tui, "\x1b[<0;2;1M")).toEqual({ consume: true });
		expect(input(tui, "\x1b[<32;20;10M")).toEqual({ consume: true });
		expect(input(tui, "\x1b[<0;20;10m")).toEqual({ consume: true });
		expect(component.events.map((event) => event.type)).toEqual(["press", "drag", "release"]);
		expect(component.events[1]).toMatchObject({ row: 9, col: 19 });
		expect(tui.nativeInputs).toEqual([]);
		dispose();
	});

	test("derives hit boxes for Container children absent from currentLayout", () => {
		const target = new TestComponent(() => true);
		const widgetContainer = new Container();
		widgetContainer.addChild(new Spacer(1));
		widgetContainer.addChild(new LinesComponent([]));
		widgetContainer.addChild(target);
		const tui = createTui(box(widgetContainer, [], 0, 17, 20, 2));
		const dispose = installMouseBridge(asTui(tui), registry());

		expect(input(tui, "\x1b[<0;3;19M")).toEqual({ consume: true });
		expect(target.events[0]).toMatchObject({ type: "press", row: 0, col: 2, screenRow: 18 });
		expect(tui.nativeInputs).toEqual([]);
		dispose();
	});

	test("measures a flattened mouse target only once per dispatch", () => {
		const target = new RenderCountingMouseComponent(() => true);
		const document = new Container();
		document.addChild(target);
		const tui = createTui(box(document, [], 0, 0, 20, 1));
		const dispose = installMouseBridge(asTui(tui), registry());

		expect(input(tui, "\x1b[<64;2;1M")).toEqual({ consume: true });
		expect(target.renders).toBe(1);
		dispose();
	});

	test("does not render flattened containers with no mouse descendants on hover", () => {
		const transcript = new RenderCountingComponent();
		const document = new Container();
		document.addChild(transcript);
		const tui = createTui(box(document, [], 0, 0, 80, 20));
		const dispose = installMouseBridge(asTui(tui), registry());

		expect(input(tui, "\x1b[<35;2;1M")).toEqual({ data: "native:\x1b[<35;2;1M" });
		expect(transcript.renders).toBe(0);
		dispose();
	});

	test("uses cached tool geometry without rerendering transcript children during interaction", () => {
		const transcript = new RenderCountingComponent();
		const surface = new ToolViewRegion({
			theme,
			requestRender() {},
			modes: [
				{ id: "preview", component: transcript, nextHint: "expand", activate: "full" },
				{ id: "full", component: transcript, nextHint: "collapse", activate: "preview" },
			],
		});
		const wrapper = new ComponentStack([surface]);
		const lines = wrapper.render(20);
		expect(transcript.renders).toBe(1);
		const tui = createTui(box(wrapper, [], 0, 0, 20, lines.length));
		const dispose = installMouseBridge(asTui(tui), registry());

		input(tui, "\x1b[<35;2;2M");
		input(tui, "\x1b[<0;2;2M");
		input(tui, "\x1b[<0;2;2m");
		input(tui, "\r");

		expect(transcript.renders).toBe(1);
		dispose();
	});

	test("dispatches a non-consuming overlay observer once for a selectable body press", () => {
		const transcript = new LinesComponent(["select me"]);
		const tui = createTui(box(transcript, [], 0, 0, 20, 2));
		const mouseRegistry = registry();
		let presses = 0;
		mouseRegistry.registerOverlayRegion({
			id: "copy-mode-cursor",
			getRect: () => ({ x: 0, y: 0, width: 20, height: 2 }),
			onMouse(event) {
				if (event.type === "press") presses++;
				return false;
			},
		});
		const dispose = installMouseBridge(asTui(tui), mouseRegistry);

		expect(input(tui, "\x1b[<0;2;2M")).toEqual({ data: "native:\x1b[<0;2;2M" });
		expect(presses).toBe(1);
		expect(tui.nativeInputs).toEqual(["\x1b[<0;2;2M"]);
		dispose();
	});

	test("resolves captured component geometry from the current layout", () => {
		const component = new TestComponent(() => true);
		const root = box(component, [], 0, 0, 5, 2);
		const tui = createTui(root);
		const dispose = installMouseBridge(asTui(tui), registry());

		input(tui, "\x1b[<0;2;1M");
		root.rect.y = 5;
		root.clip.y = 5;
		input(tui, "\x1b[<32;2;7M");

		expect(component.events[1]).toMatchObject({ type: "drag", row: 1, col: 1 });
		dispose();
	});

	test("releases capture and hover on focus-out", () => {
		const component = new TestComponent(() => true);
		const tui = createTui(box(component));
		const dispose = installMouseBridge(asTui(tui), registry());

		input(tui, "\x1b[<35;2;1M");
		input(tui, "\x1b[<0;2;1M");
		const rendersBeforeFocusOut = tui.renders;
		expect(input(tui, "\x1b[O")).toEqual({ data: "native:\x1b[O" });

		expect(component.events.map((event) => event.type)).toEqual(["enter", "press", "release", "leave"]);
		expect(tui.renders).toBeGreaterThan(rendersBeforeFocusOut);
		dispose();
	});

	test("cancels a selection-safe text click on focus-out", () => {
		const region = viewRegion();
		region.render(20);
		const events: string[] = [];
		const onMouse = region.onMouse.bind(region);
		region.onMouse = (event) => {
			events.push(event.type);
			return onMouse(event);
		};
		const tui = createTui(box(region, [], 0, 0, 20, 2));
		const dispose = installMouseBridge(asTui(tui), registry());

		input(tui, "\x1b[<0;2;1M");
		const rendersBeforeFocusOut = tui.renders;
		input(tui, "\x1b[O");

		expect(events).toEqual(["press", "release"]);
		expect(region.getMode()).toBe("preview");
		expect(tui.renders).toBeGreaterThan(rendersBeforeFocusOut);
		dispose();
	});

	test("leaves a hovered component when motion exits its clip", () => {
		const component = new TestComponent(() => true);
		const target = box(component, [], 0, 0, 10, 2);
		target.clip.width = 3;
		const tui = createTui(target);
		const dispose = installMouseBridge(asTui(tui), registry());

		input(tui, "\x1b[<35;2;1M");
		input(tui, "\x1b[<35;6;1M");

		expect(component.events.map((event) => event.type)).toEqual(["enter", "leave"]);
		dispose();
	});

	test("does not steal a drag after Pi starts native selection", () => {
		const component = new TestComponent(() => true);
		const tui = createTui(box(component));
		const dispose = installMouseBridge(asTui(tui), registry());
		tui.selectionPressActive = true;

		expect(input(tui, "\x1b[<32;2;1M")).toEqual({ data: "native:\x1b[<32;2;1M" });
		expect(component.events).toEqual([]);
		dispose();
	});

	test("publishes normalized native selection metadata after unhandled release", () => {
		const scrollView = { scrollTop: 5 };
		const root = box(new LinesComponent([]), [], 0, 2, 40, 10);
		root.scrollView = scrollView;
		root.scrollContentLines = [
			"cdef",
			"middle",
			"uvwxy",
			"x".repeat(100),
			"four",
			"five",
			"abcdef",
			"\x1b[31mmiddle\x1b[0m",
			"uvwxyz",
		];
		const prototype = createPrototype();
		prototype.handleViewportInput = function (this: TestTui, data) {
			this.nativeInputs.push(data);
			if (data.startsWith("\x1b[<0;") && data.endsWith("m")) this.selectionPressActive = false;
			return { data: `native:${data}` };
		};
		const tui = createTui(root, prototype);
		tui.selectionPressActive = true;
		tui.selectionAnchor = { row: 8, col: 4, scrollView };
		tui.selectionFocus = { row: 6, col: 2, scrollView };
		const mouseRegistry = registry();
		const selections: object[] = [];
		const removeSelection = ensureSelectionRegistry().onSelectionCompleted((selection) => {
			expect(tui.nativeInputs).toHaveLength(1);
			selections.push(selection);
		});
		const dispose = installMouseBridge(asTui(tui), mouseRegistry);

		expect(input(tui, "\x1b[<0;5;6m")).toEqual({ data: "native:\x1b[<0;5;6m" });
		expect(selections).toEqual([
			{
				text: "cdef\nmiddle\nuvwxy",
				shape: "character",
				logical: { start: { row: 6, col: 2 }, end: { row: 8, col: 4 } },
				screen: { start: { row: 3, col: 2 }, end: { row: 5, col: 4 } },
				source: {
					quote: {
						exact: "cdef\nmiddle\nuvwxy",
						prefix: `${"x".repeat(67)}\nfour\nfive\nab`,
						suffix: "z",
					},
				},
			},
		]);
		expect((selections[0] as NativeSelectionCompleted).source?.quote?.prefix).toHaveLength(80);
		dispose();
		removeSelection();
	});

	test("ignores native releases that do not end the active selection", () => {
		const scrollView = { scrollTop: 0 };
		const root = box(new LinesComponent([]), [], 0, 0, 20, 10);
		root.scrollView = scrollView;
		const tui = createTui(root);
		tui.selectionPressActive = true;
		tui.selectionAnchor = { row: 1, col: 1, scrollView };
		tui.selectionFocus = { row: 2, col: 2, scrollView };
		const mouseRegistry = registry();
		const selections: object[] = [];
		const removeSelection = ensureSelectionRegistry().onSelectionCompleted((selection) => selections.push(selection));
		const dispose = installMouseBridge(asTui(tui), mouseRegistry);

		input(tui, "\x1b[<1;2;2m");
		input(tui, "\x1b[<2;2;2m");
		expect(tui.selectionPressActive).toBe(true);
		expect(selections).toEqual([]);
		dispose();
		removeSelection();
	});

	test("conditionally suppresses native auto-copy only around the selection release", () => {
		let copies = 0;
		const scrollView = { scrollTop: 0 };
		const root = box(new LinesComponent([]), [], 0, 0, 20, 10);
		root.scrollView = scrollView;
		const prototype = createPrototype();
		prototype.handleViewportInput = function (this: TestTui, data) {
			this.nativeInputs.push(data);
			if (data.startsWith("\x1b[<0;") && data.endsWith("m")) {
				this.selectionPressActive = false;
				this.copySelectionToClipboard?.();
			}
			return { data: `native:${data}` };
		};
		const tui = createTui(root, prototype);
		const nativeCopy = () => (copies += 1);
		tui.copySelectionToClipboard = nativeCopy;
		tui.selectionPressActive = true;
		tui.selectionAnchor = { row: 1, col: 1, scrollView };
		tui.selectionFocus = { row: 2, col: 2, scrollView };
		const mouseRegistry = registry();
		mouseRegistry.registerNativeCopyDeferrer(() => {
			throw new Error("optional deferrer failed");
		});
		const removeDeferrer = mouseRegistry.registerNativeCopyDeferrer(() => true);
		const dispose = installMouseBridge(asTui(tui), mouseRegistry);

		input(tui, "\x1b[<0;2;2m");
		expect(copies).toBe(0);
		expect(tui.copySelectionToClipboard).toBe(nativeCopy);
		tui.copySelectionToClipboard();
		expect(copies).toBe(1);

		removeDeferrer();
		tui.selectionPressActive = true;
		input(tui, "\x1b[<0;2;2m");
		expect(copies).toBe(2);
		dispose();
	});

	test("preserves native auto-copy when no deferrer is registered", () => {
		let copies = 0;
		const prototype = createPrototype();
		prototype.handleViewportInput = function (this: TestTui, data) {
			this.nativeInputs.push(data);
			if (data.endsWith("m")) {
				this.selectionPressActive = false;
				this.copySelectionToClipboard?.();
			}
			return { data: `native:${data}` };
		};
		const tui = createTui(undefined, prototype);
		tui.copySelectionToClipboard = () => (copies += 1);
		tui.selectionPressActive = true;
		tui.selectionAnchor = { row: 1, col: 1 };
		tui.selectionFocus = { row: 1, col: 2 };
		const dispose = installMouseBridge(asTui(tui), registry());

		input(tui, "\x1b[<0;2;2m");
		expect(copies).toBe(1);
		dispose();
	});

	test("offers topmost overlay regions before layout components", () => {
		const component = new TestComponent(() => true);
		const tui = createTui(box(component));
		const mouseRegistry = registry();
		const overlayEvents: TuiMouseEvent[] = [];
		mouseRegistry.registerOverlayRegion({
			id: "annotation-actions",
			getRect: () => ({ x: 1, y: 1, width: 5, height: 2 }),
			onMouse(event) {
				overlayEvents.push(event);
				return true;
			},
		});
		const dispose = installMouseBridge(asTui(tui), mouseRegistry);

		expect(input(tui, "\x1b[<64;3;2M")).toEqual({ consume: true });
		expect(overlayEvents[0]).toMatchObject({ type: "wheel", row: 0, col: 1, wheel: -1 });
		expect(component.events).toEqual([]);
		dispose();
	});

	test("dispatches the focused Pi overlay before its raw input deferral", () => {
		const overlay = new TestComponent(() => true);
		const tui = createTui();
		const entry = { component: overlay, options: { anchor: "top-left" } };
		tui.shouldDeferViewportInputToOverlay = () => true;
		tui.getTopmostVisibleOverlay = () => entry;
		tui.resolveOverlayLayout = (_options, _height, _width, _rows) => ({
			width: 20,
			row: 2,
			col: 4,
			maxHeight: 10,
		});
		const dispose = installMouseBridge(asTui(tui), registry());

		expect(input(tui, "\x1b[<0;6;3M")).toEqual({ consume: true });
		expect(input(tui, "\x1b[<0;6;3m")).toEqual({ consume: true });
		expect(overlay.events).toHaveLength(2);
		expect(overlay.events[0]).toMatchObject({ type: "press", row: 0, col: 1, screenRow: 2, screenCol: 5 });
		expect(tui.nativeInputs).toEqual([]);
		dispose();
	});

	test("does not rerender a focused overlay during stationary motion", () => {
		const overlay = new RenderCountingMouseComponent(() => true);
		const tui = createTui();
		tui.shouldDeferViewportInputToOverlay = () => true;
		tui.getTopmostVisibleOverlay = () => ({ component: overlay, options: {} });
		tui.resolveOverlayLayout = () => ({ width: 20, row: 0, col: 0, maxHeight: 2 });
		const dispose = installMouseBridge(asTui(tui), registry());

		for (let index = 0; index < 10_000; index += 1) input(tui, "\x1b[<35;2;1M");

		expect(overlay.renders).toBe(1);
		expect(overlay.events).toHaveLength(10_000);
		dispose();
	});

	test("drops cached focused-overlay geometry when the topmost overlay changes", () => {
		const first = new RenderCountingMouseComponent(() => true);
		const second = new RenderCountingMouseComponent(() => true);
		let current = first;
		const tui = createTui();
		tui.shouldDeferViewportInputToOverlay = () => true;
		tui.getTopmostVisibleOverlay = () => ({ component: current, options: {} });
		tui.resolveOverlayLayout = () => ({ width: 20, row: 0, col: 0, maxHeight: 2 });
		const dispose = installMouseBridge(asTui(tui), registry());

		input(tui, "\x1b[<35;2;1M");
		current = second;
		input(tui, "\x1b[<35;2;1M");

		expect(first.events.map((event) => event.type)).toEqual(["enter", "leave"]);
		expect(second.events.map((event) => event.type)).toEqual(["enter"]);
		expect(first.renders).toBe(1);
		expect(second.renders).toBe(1);
		dispose();
	});

	test("orders overlay hits by priority then latest registration", () => {
		const tui = createTui();
		const mouseRegistry = registry();
		const hits: string[] = [];
		const register = (id: string, priority: number) =>
			mouseRegistry.registerOverlayRegion({
				id,
				priority,
				getRect: () => ({ x: 0, y: 0, width: 2, height: 2 }),
				onMouse() {
					hits.push(id);
					return id === "high" || id === "new-equal";
				},
			});
		register("high", 10);
		register("old-equal", 0);
		register("new-equal", 0);
		const dispose = installMouseBridge(asTui(tui), mouseRegistry);

		input(tui, "\x1b[<0;1;1M");
		expect(hits).toEqual(["high"]);
		getMouseRegistryState(mouseRegistry).regions.find((region) => region.id === "high")!.onMouse = () => false;
		hits.length = 0;
		input(tui, "\x1b[<0;1;1M");
		expect(hits).toEqual(["new-equal"]);
		dispose();
	});

	test("drops cached hover after an overlay region unregisters", () => {
		const tui = createTui();
		const mouseRegistry = registry();
		const events: string[] = [];
		const unregister = mouseRegistry.registerOverlayRegion({
			id: "temporary",
			getRect: () => ({ x: 0, y: 0, width: 4, height: 2 }),
			onMouse(event) {
				events.push(event.type);
				return true;
			},
		});
		const dispose = installMouseBridge(asTui(tui), mouseRegistry);

		input(tui, "\x1b[<35;2;1M");
		unregister();
		input(tui, "\x1b[<35;2;1M");

		expect(events).toEqual(["enter", "leave"]);
		dispose();
	});

	test("emits hover enter, move, and leave when all-motion reports arrive", () => {
		const first = new TestComponent(() => true);
		const second = new TestComponent(() => true);
		const root = new TestComponent(() => false);
		const tui = createTui(box(root, [box(first, [], 0, 0, 5, 2), box(second, [], 5, 0, 5, 2)]));
		const dispose = installMouseBridge(asTui(tui), registry());

		input(tui, "\x1b[<35;2;1M");
		input(tui, "\x1b[<35;3;1M");
		input(tui, "\x1b[<35;7;1M");

		expect(first.events.map((event) => event.type)).toEqual(["enter", "move", "leave"]);
		expect(second.events.map((event) => event.type)).toEqual(["enter"]);
		dispose();
	});

	test("keeps stationary hover storms bounded", () => {
		const component = new TestComponent(() => true);
		const tui = createTui(box(component, [], 0, 0, 20, 2));
		const dispose = installMouseBridge(asTui(tui), registry());

		for (let index = 0; index < 10_000; index += 1) input(tui, "\x1b[<35;2;1M");

		expect(component.events).toHaveLength(10_000);
		expect(tui.renders).toBe(1);
		dispose();
	});

	test("reuses flattened layout targets across unhandled motion", () => {
		const target = new RenderCountingMouseComponent(() => false);
		const document = new Container();
		document.addChild(target);
		const tui = createTui(box(document, [], 0, 0, 20, 1));
		const dispose = installMouseBridge(asTui(tui), registry());

		input(tui, "\x1b[<35;2;1M");
		input(tui, "\x1b[<35;3;1M");

		expect(target.renders).toBe(1);
		dispose();
	});

	test("releases capture and hover when the bridge is disposed", () => {
		const component = new TestComponent(() => true);
		const tui = createTui(box(component, [], 0, 0, 20, 2));
		const dispose = installMouseBridge(asTui(tui), registry());

		input(tui, "\x1b[<35;2;1M");
		input(tui, "\x1b[<0;2;1M");
		dispose();

		expect(component.events.map((event) => event.type)).toEqual(["enter", "press", "release", "leave"]);
	});

	test("bubbles hover past an innermost target that declines it", () => {
		const child = new TestComponent(() => false);
		const parent = new TestComponent(() => true);
		const tui = createTui(box(parent, [box(child, [], 0, 0, 5, 2)]));
		const dispose = installMouseBridge(asTui(tui), registry());

		expect(input(tui, "\x1b[<35;2;1M")).toEqual({ consume: true });
		expect(child.events.map((event) => event.type)).toEqual(["enter"]);
		expect(parent.events.map((event) => event.type)).toEqual(["enter"]);
		dispose();
	});

	test("installs once on the prototype and survives a replacement renderer", () => {
		const component = new TestComponent(() => true);
		const tui = createTui(box(component));
		const prototype = Object.getPrototypeOf(tui) as TestTuiPrototype;
		const original = tui.handleViewportInput;
		const firstDispose = installMouseBridge(asTui(tui), registry());
		const patched = tui.handleViewportInput;
		const secondDispose = installMouseBridge(asTui(tui), registry());
		expect(tui.handleViewportInput).toBe(patched);
		const replacementComponent = new TestComponent(() => true);
		const replacement = createTui(box(replacementComponent), prototype);
		expect(input(replacement, "\x1b[<0;2;1M")).toEqual({ consume: true });
		expect(replacementComponent.events).toHaveLength(1);

		firstDispose();
		expect(tui.handleViewportInput).toBe(patched);
		secondDispose();
		expect(tui.handleViewportInput).toBe(original);
	});

	test("publishes one current fullscreen layout capability with scroll and selection mapping", () => {
		const { tui, scrollView } = createTranscriptTui();
		const scope = globalThis as Record<PropertyKey, unknown>;
		Reflect.deleteProperty(scope, FULLSCREEN_LAYOUT_CAPABILITY_KEY);
		const dispose = installMouseBridge(asTui(tui), registry());
		const capability = getFullscreenLayoutCapability();
		expect(capability).toBeDefined();
		const duplicateDispose = installMouseBridge(asTui(tui), registry());
		expect(getFullscreenLayoutCapability()).toBe(capability);
		duplicateDispose();
		const layout = resolveFullscreenLayout(tui);
		expect(layout?.viewport).toEqual({ x: 0, y: 0, width: 20, height: 2, scrollTop: 2 });
		expect(layout?.screenPoint({ row: 2, col: 3 })).toEqual({ row: 0, col: 3 });
		expect(layout?.point({ row: 2, col: 3 }, true)).toMatchObject({ row: 2, col: 3, scrollView });
		scrollView.scrollTop = 3;
		expect(layout?.screenPoint({ row: 3, col: 1 })).toEqual({ row: 0, col: 1 });
		layout?.setSelection(layout.point({ row: 1, col: 0 }), layout.point({ row: 2, col: 1 }));
		expect(resolveFullscreenLayout(tui)?.selectionAnchor).toMatchObject({ row: 1, col: 0 });
		const absentScope = Object.create(null) as typeof globalThis;
		expect(resolveFullscreenLayout(tui, absentScope)).toBeUndefined();
		const malformedScope = Object.create(null) as Record<PropertyKey, unknown>;
		malformedScope[FULLSCREEN_LAYOUT_CAPABILITY_KEY] = {
			protocol: "pi-libtui/fullscreen-layout/v1",
			version: 1,
			resolve: () => ({ malformed: true }),
		};
		expect(resolveFullscreenLayout(tui, malformedScope as typeof globalThis)).toBeUndefined();
		const detachedScope = Object.create(null) as Record<PropertyKey, unknown>;
		detachedScope[FULLSCREEN_LAYOUT_CAPABILITY_KEY] = {
			protocol: "pi-libtui/fullscreen-layout/v1",
			version: 1,
			resolve: () => (layout ? { ...layout, primaryBox: { ...layout.primaryBox } } : undefined),
		};
		expect(resolveFullscreenLayout(tui, detachedScope as typeof globalThis)).toBeUndefined();
		dispose();
		expect(getFullscreenLayoutCapability()).toBeUndefined();
	});

	test("does not clobber a later input patch when disposed", () => {
		const component = new TestComponent(() => true);
		const tui = createTui(box(component));
		const prototype = Object.getPrototypeOf(tui) as TestTuiPrototype;
		const dispose = installMouseBridge(asTui(tui), registry());
		const laterPatch = function (this: TestTui, data: string): TuiInputListenerResult {
			this.nativeInputs.push(`later:${data}`);
			return { consume: true };
		};
		prototype.handleViewportInput = laterPatch;
		dispose();
		expect(tui.handleViewportInput).toBe(laterPatch);
	});

	test("keeps the lease across a later delegating wrapper and reinstall", () => {
		const component = new TestComponent(() => true);
		const tui = createTui(box(component));
		const prototype = Object.getPrototypeOf(tui) as TestTuiPrototype;
		const original = prototype.handleViewportInput;
		const firstDispose = installMouseBridge(asTui(tui), registry());
		const bridge = prototype.handleViewportInput;
		const wrapper = function (this: TestTui, data: string): TuiInputListenerResult {
			return Reflect.apply(bridge, this, [data]);
		};
		prototype.handleViewportInput = wrapper;
		firstDispose();

		const secondDispose = installMouseBridge(asTui(tui), registry());
		expect(prototype.handleViewportInput).toBe(wrapper);
		input(tui, "\x1b[<0;2;1M");
		expect(component.events).toHaveLength(1);

		prototype.handleViewportInput = bridge;
		secondDispose();
		expect(prototype.handleViewportInput).toBe(original);
	});

	test("patches the fullscreen prototype when the session starts in regular mode", () => {
		const regular = createTui();
		regular.mode = "regular";
		const fullscreenPrototype = TuiAltScreen.prototype as object;
		const original = Reflect.get(fullscreenPrototype, "handleViewportInput");
		const dispose = installMouseBridge(asTui(regular), registry());
		expect(Reflect.get(fullscreenPrototype, "handleViewportInput")).not.toBe(original);
		dispose();
		expect(Reflect.get(fullscreenPrototype, "handleViewportInput")).toBe(original);
	});

	test("matches Pi's multiplexer heuristic exactly", () => {
		expect(isPiMultiplexedEnvironment({ TERM: "tmux-256color" })).toBe(true);
		expect(isPiMultiplexedEnvironment({ TERM: "screen-256color" })).toBe(true);
		expect(isPiMultiplexedEnvironment({ TERM: "xterm-256color", TMUX: "" })).toBe(true);
		expect(isPiMultiplexedEnvironment({ TERM: "xterm-256color", ZELLIJ: "0" })).toBe(true);
		expect(isPiMultiplexedEnvironment({ TERM: "xterm-256color", STY: "session" })).toBe(true);
		expect(isPiMultiplexedEnvironment({ TERM: "xterm-256color" })).toBe(false);
	});

	test("all-motion tracking is immediate, ref-counted, and survives renderer start", () => {
		let starts = 0;
		const prototype: TestTuiPrototype & { beforeTerminalStart(this: TestTui): void } = {
			...createPrototype(),
			beforeTerminalStart(this: TestTui) {
				starts += 1;
				this.terminal.write("pi-start");
			},
		};
		const tui = createTui();
		Object.setPrototypeOf(tui, { ...Object.getPrototypeOf(tui), ...prototype });
		const activePrototype = Object.getPrototypeOf(tui) as object;
		const firstDispose = installAllMotionTracking(asTui(tui), activePrototype, { TERM: "tmux-256color" });
		const secondDispose = installAllMotionTracking(asTui(tui), activePrototype, { TERM: "tmux-256color" });
		expect(tui.terminal.writes).toEqual(["\x1b[?1003h"]);
		Reflect.apply(Reflect.get(activePrototype, "beforeTerminalStart"), tui, []);
		expect(starts).toBe(1);
		expect(tui.terminal.writes).toEqual(["\x1b[?1003h", "pi-start", "\x1b[?1003h"]);

		firstDispose();
		expect(tui.terminal.writes.at(-1)).toBe("\x1b[?1003h");
		secondDispose();
		expect(tui.terminal.writes.at(-1)).toBe("\x1b[?1003l");
	});

	test("all-motion waits for fullscreen after regular-mode startup and skips direct terminals", () => {
		const prototype: TestTuiPrototype & { beforeTerminalStart(this: TestTui): void } = {
			...createPrototype(),
			beforeTerminalStart(this: TestTui) {
				this.terminal.write("pi-start");
			},
		};
		const regular = createTui();
		regular.mode = "regular";
		Object.setPrototypeOf(regular, prototype);
		const dispose = installAllMotionTracking(asTui(regular), prototype, { TERM: "tmux-256color" });
		expect(regular.terminal.writes).toEqual([]);

		const fullscreen = createTui(undefined, prototype);
		Reflect.apply(Reflect.get(prototype, "beforeTerminalStart"), fullscreen, []);
		expect(fullscreen.terminal.writes).toEqual(["pi-start", "\x1b[?1003h"]);
		dispose();
		expect(regular.terminal.writes).toEqual(["\x1b[?1003l"]);

		const direct = createTui();
		const directPrototype = Object.getPrototypeOf(direct) as object;
		const original = Reflect.get(directPrototype, "beforeTerminalStart");
		installAllMotionTracking(asTui(direct), directPrototype, { TERM: "xterm-256color" });
		expect(Reflect.get(directPrototype, "beforeTerminalStart")).toBe(original);
		expect(direct.terminal.writes).toEqual([]);
	});

	test("all-motion lease stays inactive through a later delegating wrapper and restores after reinstall", () => {
		const prototype: TestTuiPrototype & { beforeTerminalStart(this: TestTui): void } = {
			...createPrototype(),
			beforeTerminalStart(this: TestTui) {
				this.terminal.write("pi-start");
			},
		};
		const tui = createTui(undefined, prototype);
		const original = prototype.beforeTerminalStart;
		const firstDispose = installAllMotionTracking(asTui(tui), prototype, { TERM: "tmux-256color" });
		const allMotion = prototype.beforeTerminalStart;
		const wrapper = function (this: TestTui): void {
			Reflect.apply(allMotion, this, []);
		};
		prototype.beforeTerminalStart = wrapper;
		firstDispose();
		expect(tui.terminal.writes.at(-1)).toBe("\x1b[?1003l");
		Reflect.apply(wrapper, tui, []);
		expect(tui.terminal.writes.at(-1)).toBe("pi-start");

		const secondDispose = installAllMotionTracking(asTui(tui), prototype, { TERM: "tmux-256color" });
		expect(tui.terminal.writes.at(-1)).toBe("\x1b[?1003h");
		Reflect.apply(wrapper, tui, []);
		expect(tui.terminal.writes.slice(-2)).toEqual(["pi-start", "\x1b[?1003h"]);

		prototype.beforeTerminalStart = allMotion;
		secondDispose();
		expect(prototype.beforeTerminalStart).toBe(original);
		expect(tui.terminal.writes.at(-1)).toBe("\x1b[?1003l");
	});
});
