import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SidePanelTab, SplitPaneHost } from "@luan.sh/pi-libtui";
import { SidePanelView, type SidePanelViewModel } from "../src/view.ts";

test("preserves the active body when only inactive tab metadata changes", () => {
	let creations = 0;
	let disposals = 0;
	const active: SidePanelTab = {
		id: "active",
		label: "Active",
		create: () => {
			creations += 1;
			return { render: () => [], invalidate() {}, dispose: () => disposals++ };
		},
	};
	let inactive: SidePanelTab = { ...active, id: "inactive", label: "Inactive" };
	const model: SidePanelViewModel = {
		runAction() {},
		tabs: () => [active, inactive],
		activeTab: () => active,
		emptyActions: () => [],
		activate() {},
		close() {},
		move() {},
		requestRender() {},
	};
	const host = {
		getTerminalSize: () => ({ columns: 80, rows: 24 }),
		requestRender() {},
		focus() {},
		blur() {},
		isFocused: () => false,
	} as never as SplitPaneHost;
	const view = new SidePanelView(model, host, {} as Theme, {});

	inactive = { ...inactive, label: "Updated" };
	view.refresh();
	expect({ creations, disposals }).toEqual({ creations: 1, disposals: 0 });

	view.dispose();
	expect(disposals).toBe(1);
});

test("runs a contributed panel action instead of forwarding its shortcut to the active child", () => {
	const actions: string[] = [];
	const childInput: string[] = [];
	const active: SidePanelTab = {
		id: "side-chat",
		label: "Side chat",
		create: () => ({
			render: () => [],
			invalidate() {},
			handleInput: (data) => childInput.push(data),
		}),
	};
	const model: SidePanelViewModel = {
		runAction: (id) => actions.push(id),
		tabs: () => [active],
		activeTab: () => active,
		emptyActions: () => [{ id: "review", label: "Review", actionId: "panels.tuicr.open" }],
		activate() {},
		close() {},
		move() {},
		requestRender() {},
	};
	const host = {
		getTerminalSize: () => ({ columns: 80, rows: 24 }),
		requestRender() {},
		focus() {},
		blur() {},
		isFocused: () => true,
	} as never as SplitPaneHost;
	const view = new SidePanelView(model, host, {} as Theme, {
		"panels.tuicr.open": ["g"],
	});

	view.handleInput("g");

	expect(actions).toEqual(["panels.tuicr.open"]);
	expect(childInput).toEqual([]);
});

test("header wheel events stay in the panel while body scrolling stays delegated", () => {
	let bodyWheels = 0;
	const active: SidePanelTab = {
		id: "settings",
		label: "Settings",
		create: () => ({
			render: () => [],
			invalidate() {},
			onMouse: () => {
				bodyWheels++;
				return false;
			},
		}),
	};
	const model: SidePanelViewModel = {
		runAction() {},
		tabs: () => [active],
		activeTab: () => active,
		emptyActions: () => [],
		activate() {},
		close() {},
		move() {},
		requestRender() {},
	};
	const host = {
		getTerminalSize: () => ({ columns: 80, rows: 24 }),
		requestRender() {},
		focus() {},
		blur() {},
		isFocused: () => false,
	} as never as SplitPaneHost;
	const view = new SidePanelView(model, host, {} as Theme, {});
	const event = {
		type: "wheel" as const,
		row: 0,
		col: 5,
		screenRow: 0,
		screenCol: 5,
		button: undefined,
		wheel: 1 as const,
		shift: false,
		alt: false,
		ctrl: false,
	};
	expect(view.onMouse(event)).toBe(true);
	expect(bodyWheels).toBe(0);
	expect(view.onMouse({ ...event, row: 5 })).toBe(false);
	expect(bodyWheels).toBe(1);
});
