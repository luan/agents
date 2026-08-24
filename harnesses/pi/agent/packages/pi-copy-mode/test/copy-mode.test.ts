import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE, tuiTheme } from "pi-libtui";
import { ensureFoldingRegistry, FOLD_TARGET_AT_ROW, type FoldTarget } from "pi-libtui/folding";
import type { MouseRegistry, TuiMouseEvent } from "pi-libtui/mouse";
import type { NativeSelectionCompleted, SelectionActionRequest, SelectionRegistry } from "pi-libtui/selection";
import type { CopyModeKeybindings } from "../src/config/keybindings.ts";
import { createCopyModeHost } from "../src/runtime/copy-mode.ts";
import {
	getLineMetricComputationCount,
	resetLineMetricComputationCount,
	validateFullscreenSurface,
} from "../src/runtime/fullscreen-surface.ts";
import { ensureTestLayoutCapability } from "./layout-capability.ts";

type InputResult = { consume?: boolean; data?: string } | undefined;
type InputHandler = (data: string) => InputResult;
type TestRegistry = MouseRegistry & {
	regions: Array<Parameters<MouseRegistry["registerOverlayRegion"]>[0]>;
	viewportInputHandlers: Array<Parameters<MouseRegistry["registerViewportInputHandler"]>[0]>;
	nativeCopyDeferrers: Array<Parameters<MouseRegistry["registerNativeCopyDeferrer"]>[0]>;
	screenDecorators: Array<Parameters<MouseRegistry["registerScreenDecorator"]>[0]>;
};

// type-boundary: The focused runtime harness implements the validated Pi 0.84.2 private fullscreen surface.
type TuiBoundary = unknown;
// type-boundary: The focused context harness implements only UI methods used by copy mode.
type ContextBoundary = unknown;
// type-boundary: The color test fixture implements only the Pi theme methods consumed by pi-libtui.
type CopyThemeBoundary = unknown;

const copyTheme = {
	name: "dark",
	getColorMode: () => "256color",
	getFgAnsi: () => "\x1b[38;5;255m",
	getBgAnsi: () => "\x1b[48;5;16m",
} as CopyThemeBoundary as Theme;

function copyCursorStyle(selected: boolean): string {
	const colors = tuiTheme(copyTheme);
	return selected
		? `\x1b[1m${colors.fgAnsi("cursor.selectedText")}${colors.bgAnsi("cursor.selected")}`
		: `\x1b[1m${colors.fgAnsi("cursor.idleText")}${colors.bgAnsi("cursor.idle")}`;
}

function copySelectionStyle(): string {
	const colors = tuiTheme(copyTheme);
	return `${colors.bgAnsi("surface.selected")}${colors.fgAnsi("text.primary")}`;
}

function nativeSelection(): NativeSelectionCompleted {
	return {
		text: "selection",
		shape: "character",
		logical: { start: { row: 1, col: 1 }, end: { row: 2, col: 4 } },
		screen: { start: { row: 1, col: 1 }, end: { row: 2, col: 4 } },
	};
}

afterEach(() => {
	configureTuiAppearance(DEFAULT_TUI_APPEARANCE);
	ensureTestLayoutCapability();
});

function bindings(entries: Partial<CopyModeKeybindings>): CopyModeKeybindings {
	return {
		"copy-mode.up": entries["copy-mode.up"] ?? [],
		"copy-mode.down": entries["copy-mode.down"] ?? [],
		"copy-mode.left": entries["copy-mode.left"] ?? [],
		"copy-mode.right": entries["copy-mode.right"] ?? [],
		"copy-mode.lineStart": entries["copy-mode.lineStart"] ?? [],
		"copy-mode.lineEnd": entries["copy-mode.lineEnd"] ?? [],
		"copy-mode.top": entries["copy-mode.top"] ?? [],
		"copy-mode.bottom": entries["copy-mode.bottom"] ?? [],
		"copy-mode.halfPageUp": entries["copy-mode.halfPageUp"] ?? [],
		"copy-mode.halfPageDown": entries["copy-mode.halfPageDown"] ?? [],
		"copy-mode.pageUp": entries["copy-mode.pageUp"] ?? [],
		"copy-mode.pageDown": entries["copy-mode.pageDown"] ?? [],
		"copy-mode.wordForward": entries["copy-mode.wordForward"] ?? [],
		"copy-mode.wordEnd": entries["copy-mode.wordEnd"] ?? [],
		"copy-mode.wordBackward": entries["copy-mode.wordBackward"] ?? [],
		"copy-mode.bigWordForward": entries["copy-mode.bigWordForward"] ?? [],
		"copy-mode.bigWordEnd": entries["copy-mode.bigWordEnd"] ?? [],
		"copy-mode.bigWordBackward": entries["copy-mode.bigWordBackward"] ?? [],
		"copy-mode.findForward": entries["copy-mode.findForward"] ?? [],
		"copy-mode.findBackward": entries["copy-mode.findBackward"] ?? [],
		"copy-mode.tillForward": entries["copy-mode.tillForward"] ?? [],
		"copy-mode.tillBackward": entries["copy-mode.tillBackward"] ?? [],
		"copy-mode.repeatFind": entries["copy-mode.repeatFind"] ?? [],
		"copy-mode.reverseFind": entries["copy-mode.reverseFind"] ?? [],
		"copy-mode.paragraphForward": entries["copy-mode.paragraphForward"] ?? [],
		"copy-mode.paragraphBackward": entries["copy-mode.paragraphBackward"] ?? [],
		"copy-mode.firstNonblank": entries["copy-mode.firstNonblank"] ?? [],
		"copy-mode.firstNonblankDown": entries["copy-mode.firstNonblankDown"] ?? [],
		"copy-mode.toggleSelection": entries["copy-mode.toggleSelection"] ?? [],
		"copy-mode.lineSelection": entries["copy-mode.lineSelection"] ?? [],
		"copy-mode.columnSelection": entries["copy-mode.columnSelection"] ?? [],
		"copy-mode.swapEnds": entries["copy-mode.swapEnds"] ?? [],
		"copy-mode.clearSelection": entries["copy-mode.clearSelection"] ?? [],
		"copy-mode.copy": entries["copy-mode.copy"] ?? [],
		"copy-mode.annotate": entries["copy-mode.annotate"] ?? [],
		"copy-mode.react": entries["copy-mode.react"] ?? [],
		"copy-mode.cancel": entries["copy-mode.cancel"] ?? [],
		"copy-mode.foldPrefix": entries["copy-mode.foldPrefix"] ?? [],
		"copy-mode.foldOpen": entries["copy-mode.foldOpen"] ?? [],
		"copy-mode.foldClose": entries["copy-mode.foldClose"] ?? [],
		"copy-mode.foldOpenAll": entries["copy-mode.foldOpenAll"] ?? [],
		"copy-mode.foldCloseAll": entries["copy-mode.foldCloseAll"] ?? [],
	};
}

function harness(
	options: {
		anchor?: { row: number; col: number };
		focus?: { row: number; col: number };
		mode?: string;
		hardwareCursor?: boolean;
		injectedCopy?: boolean;
		copyOnSelect?: boolean;
		lines?: string[];
		annotationGate?: Promise<void>;
		annotationResult?: boolean;
		contentComponent?: object;
	} = {},
) {
	let input: InputHandler | undefined;
	let copied = 0;
	let renders = 0;
	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];
	const published: NativeSelectionCompleted[] = [];
	const annotations: SelectionActionRequest[] = [];
	const copiedTexts: string[] = [];
	const flashes: string[] = [];
	const overlays: Array<{
		component: { render(width: number): string[] };
		options: { row?: number; col?: number; width?: number; maxHeight?: number };
		hidden: boolean;
	}> = [];
	const terminalWrites: string[] = [];
	let hardwareCursor = options.hardwareCursor ?? true;
	let overlayVisible = false;
	const scrollView = {
		scrollTop: 1,
		viewportHeight: 2,
		scrollTo(row: number) {
			this.scrollTop = row;
		},
	};
	const contentComponent = options.contentComponent ?? {};
	const contentLines = options.lines ?? ["zero", "one", "\x1b[31mA\x1b[0m界e\u0301Z", "three"];
	const renderer = {
		mode: options.mode ?? "fullscreen",
		terminal: {
			columns: 20,
			rows: 4,
			write(data: string) {
				terminalWrites.push(data);
			},
		},
		currentLayout: {
			primaryScrollView: scrollView,
			root: {
				component: {},
				rect: { x: 0, y: 0, width: 20, height: 4 },
				clip: { x: 0, y: 0, width: 20, height: 4 },
				children: [
					{
						component: {},
						rect: { x: 2, y: 1, width: 12, height: 2 },
						clip: { x: 2, y: 1, width: 12, height: 2 },
						children: [
							{
								component: contentComponent,
								rect: { x: 2, y: 0, width: 12, height: contentLines.length },
								clip: { x: 2, y: 1, width: 12, height: 2 },
								children: [],
							},
						],
						scrollView,
						scrollContentLines: contentLines,
					},
				],
			},
		},
		selectionAnchor: options.anchor ? { ...options.anchor, scrollView } : undefined,
		selectionFocus: options.focus ? { ...options.focus, scrollView } : undefined,
		async copySelectionToClipboard() {
			copied += 1;
		},
		copySelection:
			options.injectedCopy === false
				? undefined
				: async (text: string) => {
						copiedTexts.push(text);
						return true;
					},
		flash(message: string) {
			flashes.push(message);
		},
		getShowHardwareCursor() {
			return hardwareCursor;
		},
		setShowHardwareCursor(value: boolean) {
			hardwareCursor = value;
		},
		showOverlay(
			component: { render(width: number): string[] },
			overlayOptions: { row?: number; col?: number; width?: number; maxHeight?: number },
		) {
			const entry = { component, options: overlayOptions, hidden: false };
			overlays.push(entry);
			return {
				hide() {
					entry.hidden = true;
				},
				setHidden(value: boolean) {
					entry.hidden = value;
				},
				isHidden() {
					return entry.hidden;
				},
				focus() {},
				unfocus() {},
			};
		},
		hasOverlay() {
			return overlayVisible;
		},
		requestRender() {
			renders += 1;
		},
		requestImmediateRender() {
			renders += 1;
		},
	};
	const context = {
		mode: "tui",
		ui: {
			theme: copyTheme,
			notify(message: string) {
				notifications.push(message);
			},
			setStatus(_key: string, value: string | undefined) {
				statuses.push(value);
			},
			onTerminalInput(handler: InputHandler) {
				input = handler;
				return () => {
					input = undefined;
				};
			},
		},
	};
	const registry: TestRegistry = {
		protocol: "pi-libtui/mouse/registry/v1",
		version: 1,
		regions: [],
		viewportInputHandlers: [],
		nativeCopyDeferrers: [],
		screenDecorators: [],
		registerOverlayRegion(region) {
			this.regions.push(region);
			return () => {
				const index = this.regions.indexOf(region);
				if (index >= 0) this.regions.splice(index, 1);
			};
		},
		registerViewportInputHandler(handler) {
			this.viewportInputHandlers.push(handler);
			return () => {
				const index = this.viewportInputHandlers.indexOf(handler);
				if (index >= 0) this.viewportInputHandlers.splice(index, 1);
			};
		},
		dispatchViewportInput(data) {
			let current = data;
			for (const handler of [...this.viewportInputHandlers].sort(
				(left, right) => (right.priority ?? 0) - (left.priority ?? 0),
			)) {
				const result = handler.handle(current);
				if (result?.data !== undefined) current = result.data;
				if (result?.consume) return { data: current, consumed: true };
			}
			return { data: current, consumed: false };
		},
		registerNativeCopyDeferrer(deferrer) {
			this.nativeCopyDeferrers.push(deferrer);
			return () => {
				const index = this.nativeCopyDeferrers.indexOf(deferrer);
				if (index >= 0) this.nativeCopyDeferrers.splice(index, 1);
			};
		},
		shouldDeferNativeCopy() {
			return this.nativeCopyDeferrers.some((deferrer) => deferrer());
		},
		registerScreenDecorator(decorator) {
			this.screenDecorators.push(decorator);
			return () => {
				const index = this.screenDecorators.indexOf(decorator);
				if (index >= 0) this.screenDecorators.splice(index, 1);
			};
		},
		dispatchScreenDecorators(screen, decorationContext) {
			return this.screenDecorators.reduce(
				(current, decorator) => decorator.decorate(current, decorationContext),
				screen,
			);
		},
	};
	let selectionCompletedListener: ((selection: NativeSelectionCompleted) => void) | undefined;
	const selection: SelectionRegistry = {
		protocol: "pi-libtui/selection/v1",
		version: 1,
		onSelectionCompleted(listener) {
			selectionCompletedListener = listener;
			return () => {
				if (selectionCompletedListener === listener) selectionCompletedListener = undefined;
			};
		},
		publishSelectionCompleted(selection) {
			published.push(selection);
			selectionCompletedListener?.(selection);
		},
		onSelectionAction(listener) {
			return () => {
				void listener;
			};
		},
		async publishSelectionAction(request) {
			annotations.push(request);
			await options.annotationGate;
			return options.annotationResult ?? false;
		},
	};
	const tuiBoundary: TuiBoundary = renderer;
	const contextBoundary: ContextBoundary = context;
	return {
		renderer,
		registry,
		statuses,
		notifications,
		published,
		annotations,
		copiedTexts,
		flashes,
		terminalWrites,
		overlays,
		get hardwareCursor() {
			return hardwareCursor;
		},
		setOverlayVisible(value: boolean) {
			overlayVisible = value;
		},
		get copied() {
			return copied;
		},
		get renders() {
			return renders;
		},
		get input() {
			return input;
		},
		completeSelection(
			selectionValue: NativeSelectionCompleted = {
				text: "selected",
				shape: "character",
				logical: { start: { row: 1, col: 1 }, end: { row: 2, col: 4 } },
				screen: { start: { row: 1, col: 1 }, end: { row: 2, col: 4 } },
			},
		) {
			selection.publishSelectionCompleted(selectionValue);
		},
		decorate(screen: string[], _legacyLayout?: object) {
			return registry.dispatchScreenDecorators(screen, {
				width: renderer.terminal.columns,
				height: renderer.terminal.rows,
				hasOverlay: overlayVisible,
			});
		},
		host(keys: CopyModeKeybindings) {
			return createCopyModeHost(tuiBoundary as TUI, contextBoundary as ExtensionContext, {
				bindings: keys,
				registry,
				selection,
				copyOnSelect: options.copyOnSelect,
			});
		},
	};
}

describe("copy mode", () => {
	test("validation and repeated motion leave untouched transcript rows unsegmented", () => {
		const lines = Array.from({ length: 10_000 }, (_unused, index) => `line-${index}`);
		const view = harness({ lines });
		const tuiBoundary: TuiBoundary = view.renderer;
		resetLineMetricComputationCount();
		for (let index = 0; index < 100; index += 1) {
			expect(validateFullscreenSurface(tuiBoundary as TUI)).toBeDefined();
		}
		expect(getLineMetricComputationCount()).toBe(0);
		const host = view.host(bindings({ "copy-mode.left": ["h"], "copy-mode.right": ["l"] }));
		host.enter();
		expect(getLineMetricComputationCount()).toBe(1);
		for (let index = 0; index < 100; index += 1) {
			view.registry.dispatchViewportInput(index % 2 === 0 ? "l" : "h");
			view.decorate(["", "", "  line-2", ""]);
		}
		expect(getLineMetricComputationCount()).toBe(1);
		lines[2] = "界";
		view.decorate(["", "", "  ���", ""]);
		expect(getLineMetricComputationCount()).toBe(2);
	});

	test("keyboard entry starts at the bottom visible row and motion keeps the cursor visible", () => {
		const view = harness();
		const host = view.host(bindings({ "copy-mode.down": ["x"], "copy-mode.right": ["r"] }));
		expect(host.enter()).toBe(true);
		expect(host.cursor).toEqual({ row: 2, col: 0 });
		const rendersBeforeMotion = view.renders;
		expect(view.input?.("x")).toEqual({ consume: true });
		expect(view.renders - rendersBeforeMotion).toBe(1);
		expect(host.cursor).toEqual({ row: 3, col: 0 });
		expect(view.renderer.currentLayout.primaryScrollView.scrollTop).toBe(2);
		expect(view.input?.("r")).toEqual({ consume: true });
		expect(host.cursor).toEqual({ row: 3, col: 1 });
	});

	test("prioritized viewport input wins without duplicate fallback handling", () => {
		const view = harness();
		const host = view.host(bindings({ "copy-mode.right": ["l"] }));
		host.enter();
		expect(view.registry.viewportInputHandlers).toHaveLength(2);
		expect(view.registry.dispatchViewportInput("l")).toEqual({ data: "l", consumed: true });
		expect(view.input?.("l")).toEqual({ consume: true });
		expect(host.cursor).toEqual({ row: 2, col: 1 });
		host.dispose();
		expect(view.registry.viewportInputHandlers).toHaveLength(0);
		expect(view.input).toBeUndefined();
	});

	test("focused overlays receive keys without leaving copy mode", () => {
		const view = harness();
		const host = view.host(bindings({ "copy-mode.right": ["l"] }));
		host.enter();
		view.setOverlayVisible(true);
		expect(view.registry.dispatchViewportInput("l")).toEqual({ data: "l", consumed: false });
		expect(view.input?.("l")).toBeUndefined();
		expect(host.cursor).toEqual({ row: 2, col: 0 });
		expect(host.active).toBe(true);
		view.setOverlayVisible(false);
		expect(view.registry.dispatchViewportInput("l")).toEqual({ data: "l", consumed: true });
		expect(host.cursor).toEqual({ row: 2, col: 1 });
	});

	test("focused overlay owns the only decorated cursor", () => {
		const view = harness();
		const host = view.host(bindings({}));
		host.enter();
		view.setOverlayVisible(true);
		const screen = [`overlay ${CURSOR_MARKER}\x1b[7mx\x1b[0m`, "", "  transcript", ""];
		expect(view.decorate(screen)).toEqual(screen);
		expect(host.active).toBe(true);
	});

	test("defers native mouse copy only while a valid host can adopt selection", () => {
		const view = harness();
		const host = view.host(bindings({}));
		expect(view.registry.shouldDeferNativeCopy()).toBe(true);
		host.dispose();
		expect(view.registry.shouldDeferNativeCopy()).toBe(false);
		const regular = harness({ mode: "main" });
		const regularHost = regular.host(bindings({}));
		expect(regular.registry.shouldDeferNativeCopy()).toBe(false);
		regularHost.dispose();
		const copyOnSelect = harness({ copyOnSelect: true });
		const copyOnSelectHost = copyOnSelect.host(bindings({}));
		expect(copyOnSelect.registry.shouldDeferNativeCopy()).toBe(false);
		copyOnSelectHost.dispose();
	});

	test("toggle fixes the anchor while motion extends selection", () => {
		const view = harness();
		const host = view.host(bindings({ "copy-mode.toggleSelection": ["v"], "copy-mode.right": ["l"] }));
		host.enter();
		view.input?.("v");
		view.input?.("l");
		expect(host.cursor).toEqual({ row: 2, col: 1 });
		expect(view.renderer.selectionFocus).toMatchObject({ row: 2, col: 1 });
	});

	test("dispatches local fold sequences to the fold under the copy cursor", () => {
		const folding = ensureFoldingRegistry();
		function target(): FoldTarget & { folded: boolean; opened: number; closed: number } {
			const value = {
				folded: true,
				opened: 0,
				closed: 0,
				isFolded: () => value.folded,
				open: () => {
					value.folded = false;
					value.opened += 1;
				},
				close: () => {
					value.folded = true;
					value.closed += 1;
				},
			};
			return value;
		}
		const first = target();
		const second = target();
		const firstComponent = { [FOLD_TARGET_AT_ROW]: () => first };
		const secondComponent = { [FOLD_TARGET_AT_ROW]: () => second };
		const contentComponent = {
			getSpans: () => [
				{ component: firstComponent, row: 1, height: 1, width: 12 },
				{ component: secondComponent, row: 2, height: 1, width: 12 },
			],
		};
		const removeFirst = folding.register(first);
		const removeSecond = folding.register(second);
		const view = harness({ contentComponent });
		const host = view.host(
			bindings({
				"copy-mode.up": ["k"],
				"copy-mode.foldPrefix": ["z"],
				"copy-mode.foldOpen": ["o"],
				"copy-mode.foldClose": ["c"],
				"copy-mode.foldOpenAll": ["shift+r"],
				"copy-mode.foldCloseAll": ["shift+m"],
			}),
		);
		host.enter();
		view.input?.("o");
		expect(second.opened).toBe(0);
		view.input?.("z");
		view.input?.("o");
		expect(second.opened).toBe(1);
		expect(first.opened).toBe(0);
		view.input?.("k");
		view.input?.("z");
		view.input?.("c");
		expect(first.closed).toBe(1);
		expect(second.closed).toBe(0);
		removeFirst();
		removeSecond();
		host.dispose();
	});

	test("clear selection collapses to the cursor and stays in copy mode", () => {
		const view = harness();
		const host = view.host(
			bindings({
				"copy-mode.toggleSelection": ["v"],
				"copy-mode.right": ["l"],
				"copy-mode.clearSelection": ["escape"],
				"copy-mode.cancel": ["q"],
			}),
		);
		host.enter();
		view.input?.("v");
		view.input?.("l");
		expect(host.cursor).toEqual({ row: 2, col: 1 });
		view.input?.("\x1b");
		expect(host.active).toBe(true);
		expect(view.renderer.selectionAnchor).toBeUndefined();
		expect(host.cursor).toEqual({ row: 2, col: 1 });
		expect(view.renderer.selectionFocus).toBeUndefined();
		expect(view.statuses.at(-1)).toBe("COPY MODE");
		expect(view.registry.viewportInputHandlers).toHaveLength(2);
		view.input?.("q");
		expect(host.active).toBe(false);
	});

	test("Ctrl-[ follows Escape pending-cancel then deselect grammar", () => {
		const view = harness();
		const host = view.host(
			bindings({
				"copy-mode.toggleSelection": ["v"],
				"copy-mode.right": ["l"],
				"copy-mode.findForward": ["f"],
				"copy-mode.clearSelection": ["escape"],
			}),
		);
		host.enter();
		view.input?.("v");
		view.input?.("l");
		view.input?.("f");
		expect(view.statuses.at(-1)).toBe("COPY MODE · character · f");
		view.input?.("\x1b[91;5u");
		expect(view.statuses.at(-1)).toBe("COPY MODE · character");
		expect(view.renderer.selectionAnchor).toMatchObject({ row: 2, col: 0 });
		view.input?.("\x1b[91;5u");
		expect(host.active).toBe(true);
		expect(view.statuses.at(-1)).toBe("COPY MODE");
		expect(view.renderer.selectionAnchor).toBeUndefined();
		expect(host.cursor).toEqual({ row: 2, col: 1 });
	});

	test("renders a distinct cursor over selections and blank lines", () => {
		const view = harness();
		view.renderer.currentLayout.root.children[0]!.scrollContentLines[1] = "";
		const host = view.host(bindings({ "copy-mode.toggleSelection": ["v"], "copy-mode.up": ["k"] }));
		host.enter();
		view.input?.("v");
		view.input?.("k");
		const screen = view.decorate(["editor", "", "  selected", "footer"]);
		expect(screen[1]).toContain(`${copyCursorStyle(true)} \x1b[0m`);
		expect(screen[1]).toContain("  ");
	});

	test("uses navigation and selection cursor roles", () => {
		configureTuiAppearance({ navigationCursor: "steady-bar", selectionCursor: "virtual" });
		const view = harness();
		const host = view.host(bindings({ "copy-mode.toggleSelection": ["v"] }));
		host.enter();
		const navigation = view.decorate(["", "", "  \x1b[31mA\x1b[0m界éZ", ""])[2] ?? "";
		expect(navigation.split(CURSOR_MARKER)).toHaveLength(2);
		expect(navigation).toContain("\x1b[31mA\x1b[0m");

		view.input?.("v");
		const selection = view.decorate(["", "", "  A界éZ", ""])[2] ?? "";
		expect(selection).not.toContain(CURSOR_MARKER);
		expect(selection).toContain(`${copyCursorStyle(true)}A\x1b[0m`);

		configureTuiAppearance({ navigationCursor: "virtual", selectionCursor: "steady-block" });
		const nativeSelection = view.decorate(["", "", "  A界éZ", ""])[2] ?? "";
		expect(nativeSelection.split(CURSOR_MARKER)).toHaveLength(2);
		expect(stripTerminalSequences(nativeSelection)).toContain("  A界éZ");
	});

	test("removes editor marker and exact fake cursor only while active", () => {
		const view = harness({ hardwareCursor: true });
		const host = view.host(bindings({ "copy-mode.cancel": ["q"] }));
		host.enter();
		const editor = `prompt ${CURSOR_MARKER}\x1b[7m界\x1b[0m rest`;
		expect(view.decorate([editor, "", "", ""])[0]).toBe("prompt 界 rest");
		const unfocusedEditor = "prompt \x1b[7m界\x1b[0m rest";
		expect(view.decorate([unfocusedEditor, "", "", ""])[0]).toBe("prompt 界 rest");
		expect(view.hardwareCursor).toBe(true);
		view.input?.("q");
		expect(view.decorate([editor, "", "", ""])[0]).toBe(editor);
	});

	test("screen decoration does not create overlays or alter mouse mapping", () => {
		const view = harness();
		const host = view.host(bindings({}));
		host.enter();
		expect(view.overlays).toEqual([]);
		expect(view.registry.regions.map((region) => region.id)).toEqual([
			"pi-copy-mode.selection-actions",
			"pi-copy-mode.cursor",
		]);
		view.renderer.selectionAnchor = { row: 1, col: 0, scrollView: view.renderer.currentLayout.primaryScrollView };
		view.renderer.selectionFocus = { row: 2, col: 1, scrollView: view.renderer.currentLayout.primaryScrollView };
		host.enter(true);
		expect(view.decorate(["", "  one", "  selected", ""])[2]).toContain(`${copyCursorStyle(true)}el\x1b[0m`);
	});

	test("a copy-mode click moves the cursor and passes through to native selection", () => {
		const view = harness();
		const host = view.host(bindings({}));
		host.enter();
		const event: TuiMouseEvent = {
			type: "press",
			row: 0,
			col: 2,
			screenRow: 1,
			screenCol: 4,
			button: 0,
			wheel: undefined,
			shift: false,
			alt: false,
			ctrl: false,
		};
		expect(view.registry.regions.find((region) => region.id === "pi-copy-mode.cursor")?.onMouse(event)).toBe(false);
		expect(host.cursor).toEqual({ row: 1, col: 2 });
		expect(view.renderer.selectionAnchor).toBeUndefined();
		expect(view.renderer.selectionFocus).toBeUndefined();
	});

	test("swaps active selection ends and moves the visual cursor", () => {
		const view = harness();
		const host = view.host(
			bindings({ "copy-mode.toggleSelection": ["v"], "copy-mode.right": ["l"], "copy-mode.swapEnds": ["o"] }),
		);
		host.enter();
		view.input?.("v");
		view.input?.("l");
		view.input?.("o");
		expect(view.renderer.selectionAnchor).toMatchObject({ row: 2, col: 1 });
		expect(view.renderer.selectionFocus).toMatchObject({ row: 2, col: 0 });
		expect(stripTerminalSequences(view.decorate(["", "", "  selected", ""])[2] ?? "").startsWith("  s")).toBe(true);
	});

	test("line selection covers complete rows in reverse", () => {
		const view = harness();
		const host = view.host(bindings({ "copy-mode.lineSelection": ["shift+v"], "copy-mode.up": ["k"] }));
		host.enter();
		view.input?.("V");
		view.input?.("k");
		expect(view.renderer.selectionAnchor).toBeUndefined();
		expect(view.renderer.selectionFocus).toBeUndefined();
		expect(host.cursor).toEqual({ row: 1, col: 0 });
		expect(view.statuses.at(-1)).toBe("COPY MODE · line");
	});

	test("line decoration highlights glyphs only and reports final glyph boundary", async () => {
		const view = harness({ lines: ["", "long   ", "", "\u754c  "] });
		const scroll = view.renderer.currentLayout.primaryScrollView;
		scroll.scrollTop = 0;
		scroll.viewportHeight = 4;
		const box = view.renderer.currentLayout.root.children[0]!;
		box.rect.height = 4;
		box.clip.height = 4;
		view.renderer.terminal.rows = 6;
		const host = view.host(
			bindings({
				"copy-mode.lineSelection": ["shift+v"],
				"copy-mode.up": ["k"],
				"copy-mode.annotate": ["c"],
			}),
		);
		host.enter();
		view.input?.("V");
		view.input?.("2");
		view.input?.("k");
		expect(view.renderer.selectionAnchor).toBeUndefined();
		const decorated = view.decorate(["", "", "  long      ", "            ", "  \u754c        ", ""]);
		expect(decorated[2]).toContain("\x1b[38;5;255;48;5;0m");
		expect(decorated[3]).not.toContain(copySelectionStyle());
		expect(decorated[4]).toContain(`${copySelectionStyle()}\u754c`);
		expect(decorated.join("\n")).not.toContain("\x1b[7m");
		view.input?.("c");
		expect(view.annotations.at(-1)).toMatchObject({
			shape: "line",
			text: "long   \n\n\u754c  \n",
			logical: { start: { row: 1, col: 0 }, end: { row: 3, col: 2 } },
			screen: { end: { row: 4, col: 4 } },
		});
		await Promise.resolve();
		await Promise.resolve();
	});

	test("line decoration preserves emoji surrogate pairs", () => {
		const view = harness({ lines: ["", "\u{1F642}  ", "", ""] });
		view.renderer.currentLayout.primaryScrollView.scrollTop = 0;
		const host = view.host(bindings({ "copy-mode.lineSelection": ["shift+v"], "copy-mode.down": ["j"] }));
		host.enter();
		view.input?.("V");
		view.input?.("j");
		const decorated = view.decorate(["", "  \u{1F642}      ", "            ", ""]);
		expect(decorated[1]).toContain(`${copySelectionStyle()}\u{1F642}`);
		expect(decorated[1]).not.toContain("�");
	});

	test("supports word and WORD motions across punctuation and transcript rows", () => {
		const view = harness({ lines: ["head", "one,two  THREE", "  next-word", "tail"] });
		view.renderer.currentLayout.primaryScrollView.scrollTop = 0;
		const host = view.host(
			bindings({
				"copy-mode.wordForward": ["w"],
				"copy-mode.wordBackward": ["b"],
				"copy-mode.bigWordForward": ["shift+w"],
				"copy-mode.bigWordEnd": ["shift+e"],
			}),
		);
		host.enter();
		view.input?.("w");
		expect(host.cursor).toEqual({ row: 1, col: 3 });
		view.input?.("W");
		expect(host.cursor).toEqual({ row: 1, col: 9 });
		view.input?.("w");
		expect(host.cursor).toEqual({ row: 2, col: 2 });
		view.input?.("b");
		expect(host.cursor).toEqual({ row: 1, col: 9 });
		view.input?.("E");
		expect(host.cursor).toEqual({ row: 1, col: 13 });
		view.input?.("E");
		expect(host.cursor).toEqual({ row: 2, col: 10 });
	});

	test("supports counted Unicode find, till, repeat, reverse, and pending cancellation", () => {
		const view = harness({ lines: ["", "a界x界z界", "", ""] });
		view.renderer.currentLayout.primaryScrollView.scrollTop = 0;
		const host = view.host(
			bindings({
				"copy-mode.findForward": ["f"],
				"copy-mode.findBackward": ["shift+f"],
				"copy-mode.tillForward": ["t"],
				"copy-mode.repeatFind": [";"],
				"copy-mode.reverseFind": [","],
				"copy-mode.clearSelection": ["escape"],
			}),
		);
		host.enter();
		view.input?.("2");
		view.input?.("f");
		expect(view.statuses.at(-1)).toBe("COPY MODE · 2f");
		view.input?.("界");
		expect(host.cursor).toEqual({ row: 1, col: 4 });
		view.input?.(";");
		expect(host.cursor).toEqual({ row: 1, col: 7 });
		view.input?.(",");
		expect(host.cursor).toEqual({ row: 1, col: 4 });
		view.input?.("t");
		view.input?.("界");
		expect(host.cursor).toEqual({ row: 1, col: 6 });
		view.input?.("f");
		expect(view.statuses.at(-1)).toBe("COPY MODE · f");
		view.input?.("\x1b");
		expect(view.statuses.at(-1)).toBe("COPY MODE");
		expect(host.active).toBe(true);
	});

	test("supports counts, paragraphs, first-nonblank, and selection end swapping", () => {
		const view = harness({ lines: ["  first", "", "   second", "continuation", "", " third"] });
		view.renderer.currentLayout.primaryScrollView.scrollTop = 0;
		const host = view.host(
			bindings({
				"copy-mode.down": ["j"],
				"copy-mode.paragraphForward": ["}"],
				"copy-mode.paragraphBackward": ["{"],
				"copy-mode.firstNonblank": ["^"],
				"copy-mode.firstNonblankDown": ["_"],
				"copy-mode.toggleSelection": ["v"],
				"copy-mode.wordForward": ["w"],
				"copy-mode.swapEnds": ["o"],
				"copy-mode.clearSelection": ["escape"],
			}),
		);
		host.enter();
		view.input?.("2");
		expect(view.statuses.at(-1)).toBe("COPY MODE · 2");
		view.input?.("_");
		expect(host.cursor).toEqual({ row: 2, col: 3 });
		view.input?.("}");
		expect(host.cursor).toEqual({ row: 5, col: 0 });
		view.input?.("{");
		expect(host.cursor).toEqual({ row: 2, col: 0 });
		view.input?.("v");
		view.input?.("w");
		view.input?.("o");
		expect(view.renderer.selectionFocus).toMatchObject({ row: 2, col: 0 });
		view.input?.("3");
		view.input?.("\x1b");
		expect(view.statuses.at(-1)).toBe("COPY MODE · character");
	});

	test("applies numeric counts to basic, word, and paragraph motions", () => {
		const view = harness({ lines: ["", "a b c d", "continuation", "", "para", "", "last"] });
		view.renderer.currentLayout.primaryScrollView.scrollTop = 0;
		const host = view.host(
			bindings({
				"copy-mode.right": ["l"],
				"copy-mode.wordForward": ["w"],
				"copy-mode.paragraphForward": ["}"],
			}),
		);
		host.enter();
		view.input?.("3");
		view.input?.("l");
		expect(host.cursor).toEqual({ row: 1, col: 3 });
		view.input?.("2");
		view.input?.("w");
		expect(host.cursor).toEqual({ row: 1, col: 6 });
		view.input?.("2");
		view.input?.("}");
		expect(host.cursor).toEqual({ row: 6, col: 0 });
	});

	test("caps oversized counts and leaves bare zero as line-start", () => {
		const view = harness({ lines: ["", "abc", "", ""] });
		view.renderer.currentLayout.primaryScrollView.scrollTop = 0;
		const host = view.host(bindings({ "copy-mode.right": ["l"], "copy-mode.lineStart": ["0"] }));
		host.enter();
		for (let index = 0; index < 20; index += 1) view.input?.("9");
		expect(view.statuses.at(-1)).toBe("COPY MODE · 9999");
		view.input?.("l");
		expect(host.cursor).toEqual({ row: 1, col: 2 });
		view.input?.("0");
		expect(host.cursor).toEqual({ row: 1, col: 0 });
	});

	test("preserves preferred visual column through counted vertical and document motion", () => {
		const view = harness({ lines: ["", "abcdef", "", "abcdef"] });
		view.renderer.currentLayout.primaryScrollView.scrollTop = 0;
		const host = view.host(
			bindings({
				"copy-mode.right": ["l"],
				"copy-mode.left": ["h"],
				"copy-mode.down": ["j"],
				"copy-mode.up": ["k"],
				"copy-mode.top": ["g"],
				"copy-mode.bottom": ["shift+g"],
			}),
		);
		host.enter();
		view.input?.("5");
		view.input?.("l");
		view.input?.("2");
		view.input?.("j");
		expect(host.cursor).toEqual({ row: 3, col: 5 });
		view.input?.("k");
		expect(host.cursor).toEqual({ row: 2, col: 0 });
		view.input?.("k");
		expect(host.cursor).toEqual({ row: 1, col: 5 });
		view.input?.("h");
		view.input?.("G");
		view.input?.("g");
		view.input?.("j");
		expect(host.cursor).toEqual({ row: 1, col: 4 });
	});

	test("paragraph motion resets the preferred column to line start", () => {
		const view = harness({ lines: ["", "abcdef", "", "paragraph", "next"] });
		view.renderer.currentLayout.primaryScrollView.scrollTop = 0;
		const host = view.host(
			bindings({
				"copy-mode.right": ["l"],
				"copy-mode.paragraphForward": ["}"],
				"copy-mode.down": ["j"],
			}),
		);
		host.enter();
		view.input?.("5");
		view.input?.("l");
		expect(host.cursor).toEqual({ row: 1, col: 5 });
		view.input?.("}");
		expect(host.cursor).toEqual({ row: 3, col: 0 });
		view.input?.("j");
		expect(host.cursor).toEqual({ row: 4, col: 0 });
	});

	test("non-printable input cancels pending find without executing its action", () => {
		const view = harness({ lines: ["zero", "abc", "target", ""] });
		view.renderer.currentLayout.primaryScrollView.scrollTop = 1;
		const host = view.host(
			bindings({
				"copy-mode.findForward": ["f"],
				"copy-mode.up": ["up"],
				"copy-mode.clearSelection": ["escape"],
			}),
		);
		host.enter();
		view.input?.("f");
		expect(view.statuses.at(-1)).toBe("COPY MODE · f");
		view.input?.("\x1b[A");
		expect(host.cursor).toEqual({ row: 2, col: 0 });
		expect(view.statuses.at(-1)).toBe("COPY MODE");
		view.input?.("\x1b[A");
		expect(host.cursor).toEqual({ row: 1, col: 0 });
	});

	test("switching visual kinds preserves the original anchor", () => {
		const view = harness();
		const host = view.host(
			bindings({
				"copy-mode.toggleSelection": ["v"],
				"copy-mode.lineSelection": ["shift+v"],
				"copy-mode.columnSelection": ["ctrl+v"],
				"copy-mode.right": ["l"],
				"copy-mode.down": ["j"],
				"copy-mode.annotate": ["c"],
			}),
		);
		host.enter();
		view.input?.("v");
		view.input?.("l");
		view.input?.("V");
		view.input?.("j");
		view.input?.("\x16");
		view.input?.("c");
		expect(view.annotations.at(-1)?.logical.start).toEqual({ row: 2, col: 0 });
		expect(view.annotations.at(-1)?.logical.end.row).toBe(3);
	});

	test("copy cursor preserves the underlying wide grapheme with a block background", () => {
		const view = harness();
		const host = view.host(bindings({ "copy-mode.right": ["l"] }));
		host.enter();
		view.input?.("l");
		const decorated = view.decorate(["", "", "  A界éZ", ""])[2] ?? "";
		expect(decorated).toContain(`${copyCursorStyle(false)}界\x1b[0m`);
		expect(stripTerminalSequences(decorated)).toContain("A界éZ");
	});

	test("column selection renders and copies a real rectangle", async () => {
		const view = harness();
		const host = view.host(
			bindings({
				"copy-mode.right": ["l"],
				"copy-mode.down": ["j"],
				"copy-mode.columnSelection": ["ctrl+v"],
				"copy-mode.copy": ["y"],
			}),
		);
		host.enter();
		view.input?.("l");
		view.input?.("\x16");
		view.input?.("l");
		view.input?.("j");
		expect(view.renderer.selectionAnchor).toBeUndefined();
		const visible = view.decorate(["", "", "  A界éZ", "  three"]);
		expect(visible[1]).toContain(copySelectionStyle());
		expect(visible[2]).toContain(`${copyCursorStyle(true)} `);
		view.input?.("y");
		await Promise.resolve();
		await Promise.resolve();
		expect(view.copied).toBe(0);
		expect(view.copiedTexts).toEqual(["界\nhr"]);
		expect(view.flashes).toEqual([]);
		expect(stripTerminalSequences(view.decorate(Array.from({ length: 4 }, () => " ".repeat(20))).join("\n"))).toContain(
			"Copied!",
		);
	});

	test("column selection preserves virtual columns on blank rows and copies padded width", async () => {
		const view = harness();
		view.renderer.currentLayout.root.children[0]!.scrollContentLines[3] = "";
		const host = view.host(
			bindings({
				"copy-mode.right": ["l"],
				"copy-mode.down": ["j"],
				"copy-mode.columnSelection": ["ctrl+v"],
				"copy-mode.swapEnds": ["o"],
				"copy-mode.copy": ["y"],
			}),
		);
		host.enter();
		view.input?.("l");
		view.input?.("l");
		view.input?.("\x16");
		view.input?.("j");
		view.input?.("l");
		const decorated = view.decorate(["", "", "     ", ""]);
		expect(decorated[2]).toContain(`${copyCursorStyle(true)} `);
		expect(decorated[2]).toContain(copySelectionStyle());
		view.input?.("o");
		expect(view.decorate(["", "     ", "     ", ""])[1]).toContain(`${copyCursorStyle(true)} `);
		view.input?.("o");
		view.input?.("y");
		await Promise.resolve();
		await Promise.resolve();
		expect(view.copiedTexts).toEqual(["éZ\n  "]);
	});

	test("column selection normalizes reverse ranges and annotates their bounding box", async () => {
		const view = harness();
		const host = view.host(
			bindings({
				"copy-mode.right": ["l"],
				"copy-mode.left": ["h"],
				"copy-mode.up": ["k"],
				"copy-mode.columnSelection": ["ctrl+v"],
				"copy-mode.annotate": ["c"],
				"copy-mode.copy": ["y"],
			}),
		);
		host.enter();
		view.input?.("l");
		view.input?.("l");
		view.input?.("\x16");
		view.input?.("h");
		view.input?.("h");
		view.input?.("k");
		view.input?.("c");
		expect(view.annotations.at(-1)?.logical).toEqual({ start: { row: 1, col: 1 }, end: { row: 2, col: 4 } });
		expect(view.annotations.at(-1)).toMatchObject({ action: "selection.comment", shape: "column", text: "ne \n界é" });
		expect(host.active).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		view.input?.("y");
		await Promise.resolve();
		await Promise.resolve();
		expect(view.copiedTexts).toEqual(["ne \n界é"]);
	});

	test("decorates against the next layout scroll, reflow, resize, and clip", () => {
		const view = harness();
		const host = view.host(bindings({}));
		host.enter();
		const nextScroll = { scrollTop: 2, viewportHeight: 1, scrollTo() {} };
		const nextLayout = {
			primaryScrollView: nextScroll,
			root: {
				component: {},
				rect: { x: 0, y: 0, width: 10, height: 3 },
				clip: { x: 0, y: 0, width: 10, height: 3 },
				children: [
					{
						component: {},
						rect: { x: 4, y: 1, width: 4, height: 1 },
						clip: { x: 4, y: 1, width: 4, height: 1 },
						children: [],
						scrollView: nextScroll,
						scrollContentLines: ["zero", "one", "reflowed", "three"],
					},
				],
			},
		};
		const decorated = view.decorate(["", "    refl", ""], nextLayout);
		expect(stripTerminalSequences(decorated[1] ?? "").startsWith("    r")).toBe(true);
		nextLayout.root.children[0]!.clip = { x: 5, y: 1, width: 3, height: 1 };
		expect(view.decorate(["", "    refl", ""], nextLayout)[1]).not.toContain("█");
	});

	test("strict rectangle slicing never paints half of a wide grapheme", () => {
		const view = harness();
		const host = view.host(bindings({ "copy-mode.right": ["l"], "copy-mode.columnSelection": ["ctrl+v"] }));
		host.enter();
		view.input?.("l");
		view.input?.("\x16");
		view.input?.("l");
		const box = view.renderer.currentLayout.root.children[0]!;
		box.clip = { x: 4, y: 1, width: 3, height: 2 };
		const line = view.decorate(["", "", "  A界éZ", ""])[2] ?? "";
		expect(line).not.toContain(`${copySelectionStyle()}界`);
	});

	test("linewise copy preserves a single blank row as a newline", async () => {
		const view = harness();
		view.renderer.currentLayout.root.children[0]!.scrollContentLines[1] = "";
		const host = view.host(
			bindings({ "copy-mode.up": ["k"], "copy-mode.lineSelection": ["shift+v"], "copy-mode.copy": ["y"] }),
		);
		host.enter();
		view.input?.("k");
		view.input?.("V");
		view.input?.("y");
		await Promise.resolve();
		await Promise.resolve();
		expect(view.copiedTexts).toEqual(["\n"]);
	});

	test("linewise copy preserves trailing spaces", async () => {
		const view = harness({ lines: ["", "abc  ", "", ""] });
		view.renderer.currentLayout.primaryScrollView.scrollTop = 0;
		const host = view.host(bindings({ "copy-mode.lineSelection": ["shift+v"], "copy-mode.copy": ["y"] }));
		host.enter();
		view.input?.("V");
		view.input?.("y");
		await Promise.resolve();
		await Promise.resolve();
		expect(view.copiedTexts).toEqual(["abc  \n"]);
	});

	test("column copy falls back to OSC 52 when Pi has no injected clipboard", async () => {
		const view = harness({ injectedCopy: false });
		const host = view.host(bindings({ "copy-mode.columnSelection": ["ctrl+v"], "copy-mode.copy": ["y"] }));
		host.enter();
		view.input?.("\x16");
		view.input?.("y");
		await Promise.resolve();
		expect(view.terminalWrites).toEqual([`\x1b]52;c;${Buffer.from("A").toString("base64")}\x07`]);
		expect(view.flashes).toEqual([]);
	});

	test("copy uses Pi's clipboard and exits, while annotate publishes a distinct request and stays active", async () => {
		const view = harness();
		const host = view.host(bindings({ "copy-mode.copy": ["y"], "copy-mode.annotate": ["c"] }));
		host.enter();
		view.input?.("c");
		expect(view.annotations).toHaveLength(1);
		expect(view.published).toHaveLength(0);
		expect(host.active).toBe(true);
		expect(view.statuses.at(-1)).toBe("COPY MODE");
		await Promise.resolve();
		await Promise.resolve();
		view.input?.("y");
		expect(view.copied).toBe(0);
		expect(view.copiedTexts).toEqual(["A"]);
		expect(view.published).toHaveLength(0);
		expect(host.active).toBe(false);
		expect(view.statuses.at(-1)).toBeUndefined();
	});

	test("comment and reaction requests suspend modal input and resume with enriched text", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const view = harness({ annotationGate: gate });
		const host = view.host(bindings({ "copy-mode.annotate": ["c"], "copy-mode.react": ["r"] }));
		host.enter();
		view.input?.("c");
		expect(view.registry.viewportInputHandlers).toHaveLength(1);
		expect(view.input).toBeUndefined();
		expect(view.annotations.at(-1)).toMatchObject({
			action: "selection.comment",
			shape: "character",
			text: "A",
			logical: { start: { row: 2, col: 0 }, end: { row: 2, col: 1 } },
			source: { offsets: { start: 9, end: 10 }, quote: { exact: "A" } },
		});
		expect(host.active).toBe(true);
		release?.();
		await gate;
		await Promise.resolve();
		expect(view.registry.viewportInputHandlers).toHaveLength(2);
		expect(view.input).toBeDefined();
		view.input?.("r");
		await Promise.resolve();
		await Promise.resolve();
		expect(view.annotations.at(-1)).toMatchObject({ action: "selection.reaction", shape: "character", text: "A" });
		expect(host.active).toBe(true);
	});

	test("confirmed comment and reaction collapse selection but keep copy mode active", async () => {
		for (const interaction of [
			{ action: "copy-mode.annotate" as const, key: "c", selectionAction: "selection.comment" as const },
			{ action: "copy-mode.react" as const, key: "r", selectionAction: "selection.reaction" as const },
		]) {
			const view = harness({ annotationResult: true });
			const host = view.host(
				bindings({
					"copy-mode.toggleSelection": ["v"],
					"copy-mode.right": ["l"],
					[interaction.action]: [interaction.key],
				}),
			);
			host.enter();
			view.input?.("v");
			view.input?.("l");
			view.input?.(interaction.key);
			await Promise.resolve();
			await Promise.resolve();
			expect(view.annotations.at(-1)?.action).toBe(interaction.selectionAction);
			expect(host.active).toBe(true);
			expect(view.statuses.at(-1)).toBe("COPY MODE");
			expect(view.renderer.selectionAnchor).toBeUndefined();
			expect(view.renderer.selectionFocus).toBeUndefined();
			expect(host.cursor).toEqual({ row: 2, col: 1 });
			expect(view.registry.viewportInputHandlers).toHaveLength(2);
		}
	});

	test("cancelled interaction preserves the active selection", async () => {
		const view = harness({ annotationResult: false });
		const host = view.host(
			bindings({
				"copy-mode.toggleSelection": ["v"],
				"copy-mode.right": ["l"],
				"copy-mode.annotate": ["c"],
			}),
		);
		host.enter();
		view.input?.("v");
		view.input?.("l");
		view.input?.("c");
		await Promise.resolve();
		await Promise.resolve();
		expect(host.active).toBe(true);
		expect(view.statuses.at(-1)).toBe("COPY MODE · character");
		expect(view.renderer.selectionAnchor).toMatchObject({ row: 2, col: 0 });
		expect(view.renderer.selectionFocus).toMatchObject({ row: 2, col: 1 });
	});

	test("line interaction carries exact trailing-space text and shape", async () => {
		const view = harness({ lines: ["", "abc  ", "", ""] });
		view.renderer.currentLayout.primaryScrollView.scrollTop = 0;
		const host = view.host(bindings({ "copy-mode.lineSelection": ["shift+v"], "copy-mode.annotate": ["c"] }));
		host.enter();
		view.input?.("V");
		view.input?.("c");
		expect(view.annotations.at(-1)).toMatchObject({ action: "selection.comment", shape: "line", text: "abc  \n" });
		await Promise.resolve();
		await Promise.resolve();
		expect(host.active).toBe(true);
	});

	test("character interaction screen end is exclusive across a wide final grapheme", async () => {
		const view = harness();
		const host = view.host(
			bindings({
				"copy-mode.toggleSelection": ["v"],
				"copy-mode.right": ["l"],
				"copy-mode.annotate": ["c"],
			}),
		);
		host.enter();
		view.input?.("v");
		view.input?.("l");
		view.input?.("c");
		expect(view.annotations.at(-1)).toMatchObject({
			shape: "character",
			text: "A界",
			logical: { start: { row: 2, col: 0 }, end: { row: 2, col: 1 } },
			screen: { start: { row: 2, col: 2 }, end: { row: 2, col: 5 } },
			screenAnchor: { row: 2, col: 5 },
		});
		await Promise.resolve();
		await Promise.resolve();
	});

	test("dispose while an interaction is pending does not reinstall modal input", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const view = harness({ annotationGate: gate });
		const host = view.host(bindings({ "copy-mode.annotate": ["c"] }));
		host.enter();
		view.input?.("c");
		host.dispose();
		release?.();
		await gate;
		await Promise.resolve();
		expect(host.active).toBe(false);
		expect(view.registry.viewportInputHandlers).toHaveLength(0);
		expect(view.input).toBeUndefined();
	});

	test("derives ANSI-free grapheme stops for wide and combining characters", () => {
		const view = harness();
		const host = view.host(bindings({ "copy-mode.right": ["l"] }));
		host.enter();
		view.input?.("l");
		expect(host.cursor).toEqual({ row: 2, col: 1 });
		expect(view.renderer.selectionFocus).toBeUndefined();
		view.input?.("l");
		expect(host.cursor).toEqual({ row: 2, col: 3 });
		view.input?.("l");
		expect(host.cursor).toEqual({ row: 2, col: 4 });
	});

	test("snaps an adopted mouse focus inside a wide grapheme to its start", () => {
		const view = harness({ anchor: { row: 2, col: 0 }, focus: { row: 2, col: 2 } });
		const host = view.host(bindings({ "copy-mode.right": ["l"] }));
		host.enter(true);
		view.input?.("l");
		expect(view.renderer.selectionFocus).toMatchObject({ row: 2, col: 3 });
	});

	test("cancel clears selection and regular mode has no input listener", () => {
		const view = harness();
		const host = view.host(bindings({ "copy-mode.cancel": ["q"] }));
		expect(view.input).toBeUndefined();
		host.enter();
		view.input?.("q");
		expect(view.renderer.selectionAnchor).toBeUndefined();
		expect(view.renderer.selectionFocus).toBeUndefined();
		expect(view.input).toBeUndefined();
	});

	test("refuses regular-screen Pi without installing modal input", () => {
		const view = harness({ mode: "main" });
		const host = view.host(bindings({ "copy-mode.cancel": ["q"] }));
		expect(host.enter()).toBe(false);
		expect(host.active).toBe(false);
		expect(view.input).toBeUndefined();
		expect(view.notifications).toEqual(["Copy mode requires Pi's fullscreen TUI."]);
	});

	test("mouse entry adopts Pi's exact existing range and does not duplicate modal state", () => {
		const view = harness({ anchor: { row: 1, col: 1 }, focus: { row: 2, col: 4 } });
		const host = view.host(bindings({ "copy-mode.right": ["l"] }));
		expect(host.enter(true)).toBe(true);
		expect(view.renderer.selectionAnchor).toMatchObject({ row: 1, col: 1 });
		expect(view.renderer.selectionFocus).toMatchObject({ row: 2, col: 4 });
		const firstInput = view.input;
		view.renderer.selectionAnchor = { row: 0, col: 2, scrollView: view.renderer.currentLayout.primaryScrollView };
		view.renderer.selectionFocus = { row: 3, col: 3, scrollView: view.renderer.currentLayout.primaryScrollView };
		expect(host.enter(true)).toBe(true);
		expect(view.input).toBe(firstInput);
		expect(view.renderer.selectionAnchor).toMatchObject({ row: 0, col: 2 });
		expect(view.renderer.selectionFocus).toMatchObject({ row: 3, col: 3 });
		expect(view.statuses).toEqual(["COPY MODE · character", "COPY MODE · character"]);
	});

	test("mouse selection stays in selection mode until a motion or annotation action", async () => {
		const view = harness({ anchor: { row: 1, col: 1 }, focus: { row: 2, col: 4 } });
		const host = view.host(bindings({ "copy-mode.right": ["l"], "copy-mode.annotate": ["c"] }));
		host.selectionCompleted(nativeSelection());
		expect(host.active).toBe(false);
		expect(view.registry.dispatchViewportInput("c").consumed).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(view.annotations.at(-1)?.action).toBe("selection.comment");
		expect(host.active).toBe(false);

		const reactionView = harness({ anchor: { row: 1, col: 1 }, focus: { row: 2, col: 4 } });
		const reactionHost = reactionView.host(bindings({ "copy-mode.react": ["r"] }));
		reactionHost.selectionCompleted(nativeSelection());
		expect(reactionView.registry.dispatchViewportInput("r").consumed).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(reactionView.annotations.at(-1)?.action).toBe("selection.reaction");
		expect(reactionHost.active).toBe(false);

		const motionView = harness({ anchor: { row: 1, col: 1 }, focus: { row: 2, col: 4 } });
		const motionHost = motionView.host(bindings({ "copy-mode.right": ["l"] }));
		motionHost.selectionCompleted(nativeSelection());
		expect(motionView.registry.dispatchViewportInput("l").consumed).toBe(true);
		expect(motionHost.active).toBe(true);
		expect(motionHost.cursor).toEqual({ row: 2, col: 4 });
	});

	test("does not adopt a stale mouse selection for a reaction", () => {
		const view = harness({ anchor: { row: 1, col: 1 }, focus: { row: 2, col: 4 } });
		const host = view.host(bindings({ "copy-mode.react": ["r"] }));
		host.selectionCompleted(nativeSelection());
		view.renderer.selectionAnchor = undefined;
		view.renderer.selectionFocus = undefined;

		expect(view.registry.dispatchViewportInput("r")).toEqual({ data: "r", consumed: false });
		expect(host.active).toBe(false);
		expect(view.annotations).toHaveLength(0);
	});

	test("ctrl+d leaves a mouse selection in selection mode", () => {
		const view = harness({ anchor: { row: 1, col: 1 }, focus: { row: 2, col: 4 } });
		const host = view.host(bindings({ "copy-mode.halfPageDown": ["ctrl+d"], "copy-mode.right": ["l"] }));
		host.selectionCompleted(nativeSelection());

		expect(view.registry.dispatchViewportInput("\x04").consumed).toBe(false);
		expect(host.active).toBe(false);
		expect(view.registry.dispatchViewportInput("l").consumed).toBe(true);
		expect(host.active).toBe(true);
	});

	test("selection action bar renders above the native range and clicks its shared action geometry", async () => {
		configureTuiAppearance({ iconPack: "nerd-fonts", powerline: true });
		const view = harness({ anchor: { row: 1, col: 1 }, focus: { row: 2, col: 4 } });
		const host = view.host(
			bindings({ "copy-mode.annotate": ["c"], "copy-mode.react": ["r"], "copy-mode.copy": ["y"] }),
		);
		const completed = nativeSelection();
		host.selectionCompleted(completed);
		const decorated = view.registry.dispatchScreenDecorators(
			Array.from({ length: 4 }, () => " ".repeat(20)),
			{
				width: 20,
				height: 4,
				hasOverlay: false,
				selectionActive: true,
				selection: completed,
			},
		);
		expect(stripTerminalSequences(decorated.join("\n"))).toContain(" 󰬊");
		const region = view.registry.regions.find((candidate) => candidate.id === "pi-copy-mode.selection-actions");
		expect(region?.getRect()).toBeDefined();
		const reactionCol = stripTerminalSequences(decorated[0]!).indexOf("") - region!.getRect()!.x;
		const event = {
			row: 0,
			col: reactionCol,
			screenRow: region!.getRect()!.y,
			screenCol: region!.getRect()!.x + reactionCol,
			button: 0 as const,
			wheel: undefined,
			shift: false,
			alt: false,
			ctrl: false,
		};
		expect(region?.onMouse({ ...event, type: "press" })).toBe(true);
		expect(region?.onMouse({ ...event, type: "release" })).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(view.annotations.at(-1)?.action).toBe("selection.reaction");
	});

	test("anchors a completed selection bar to selected content with geometry-only context", () => {
		configureTuiAppearance({ iconPack: "nerd-fonts", powerline: true });
		const view = harness({ anchor: { row: 1, col: 20 }, focus: { row: 1, col: 79 } });
		const host = view.host(bindings({}));
		const completed: NativeSelectionCompleted = {
			text: "hello",
			shape: "character",
			logical: { start: { row: 1, col: 20 }, end: { row: 1, col: 79 } },
			screen: { start: { row: 1, col: 20 }, end: { row: 1, col: 79 } },
		};
		host.selectionCompleted(completed);
		const geometry = {
			shape: completed.shape,
			logical: completed.logical,
			screen: completed.screen,
		};
		view.registry.dispatchScreenDecorators(
			Array.from({ length: 6 }, () => " ".repeat(100)),
			{
				width: 100,
				height: 6,
				hasOverlay: false,
				selectionActive: true,
				selection: geometry,
			},
		);

		const rect = view.registry.regions
			.find((candidate) => candidate.id === "pi-copy-mode.selection-actions")
			?.getRect();
		expect(rect).toBeDefined();
		expect(rect!.x).toBeLessThan(20);
	});

	test("uses active copy-mode text when the rendered endpoint includes trailing cells", () => {
		configureTuiAppearance({ iconPack: "nerd-fonts", powerline: true });
		const view = harness({ lines: ["", "zero", `${"hello"}${" ".repeat(80)}`, "three"] });
		const host = view.host(bindings({ "copy-mode.toggleSelection": ["v"], "copy-mode.right": ["l"] }));
		host.enter();
		view.input?.("v");
		for (let index = 0; index < 80; index += 1) view.input?.("l");

		view.registry.dispatchScreenDecorators(
			Array.from({ length: 6 }, () => " ".repeat(100)),
			{
				width: 100,
				height: 6,
				hasOverlay: false,
			},
		);
		const rect = view.registry.regions
			.find((candidate) => candidate.id === "pi-copy-mode.selection-actions")
			?.getRect();
		expect(rect).toBeDefined();
		expect(rect!.x).toBe(0);
	});

	test("copy action adopts selection mode, copies it, and clears the selection", async () => {
		const view = harness({ anchor: { row: 1, col: 1 }, focus: { row: 2, col: 4 } });
		const host = view.host(bindings({ "copy-mode.copy": ["y"] }));
		host.selectionCompleted(nativeSelection());
		expect(view.registry.dispatchViewportInput("y").consumed).toBe(true);
		await Promise.resolve();
		expect(view.copied).toBe(0);
		expect(view.copiedTexts).toEqual(["ne\nA界éZ"]);
		expect(host.active).toBe(false);
		expect(view.renderer.selectionAnchor).toBeUndefined();
		expect(view.renderer.selectionFocus).toBeUndefined();
	});
});
