import { expect, test } from "bun:test";
import type { Component } from "@earendil-works/pi-tui";
import { ensureSplitPaneRegistry, type SidePanelTab } from "pi-libtui";
import { SidePanelController } from "../src/controller.ts";
import type { SidePanelLayoutState } from "../src/state.ts";

function tab(id: string): SidePanelTab {
	return {
		id,
		label: id,
		create: () => ({ render: () => [], invalidate() {} }) as Component,
	};
}

test("restores contributed tabs without revealing or persisting the panel", () => {
	const initial: SidePanelLayoutState = {
		version: 1,
		visible: false,
		width: 42,
		order: ["later", "first"],
		activeTabId: "later",
	};
	const persisted: SidePanelLayoutState[] = [];
	const controller = new SidePanelController(
		initial,
		(state) => persisted.push(state),
		{} as never,
		{ defer: (callback) => callback(), executeAction() {} },
		Object.create(null) as typeof globalThis,
	);

	controller.restoreTab(tab("first"));
	expect(controller.isVisible()).toBe(false);
	expect(controller.activeTabId()).toBe("first");
	expect(controller.tabs().map((item) => item.id)).toEqual(["first"]);
	expect(persisted).toEqual([]);

	controller.restoreTab(tab("later"));
	expect(controller.activeTabId()).toBe("later");
	expect(controller.tabs().map((item) => item.id)).toEqual(["later", "first"]);
	expect(persisted).toEqual([]);
	controller.dispose();
});

test("closing the final tab hides the panel until it is explicitly reopened", () => {
	const persisted: SidePanelLayoutState[] = [];
	const scope = Object.create(null) as typeof globalThis;
	const controller = new SidePanelController(
		undefined,
		(state) => persisted.push(state),
		{} as never,
		{ defer: (callback) => callback(), executeAction() {} },
		scope,
	);

	controller.addTab(tab("only"));
	expect(controller.isVisible()).toBe(true);
	controller.removeTab("only");
	expect(controller.isVisible()).toBe(false);
	expect(persisted.at(-1)).toMatchObject({ visible: false, order: [], activeTabId: undefined });

	controller.toggle();
	expect(controller.isVisible()).toBe(true);
	controller.dispose();
});

test("delegates actions and deferred zoom remounts through its explicit runtime", () => {
	const deferred: Array<() => void> = [];
	const actions: string[] = [];
	const scope = Object.create(null) as typeof globalThis;
	const controller = new SidePanelController(
		undefined,
		() => {},
		{} as never,
		{
			defer: (callback) => deferred.push(callback),
			executeAction: (id) => actions.push(id),
		},
		scope,
	);

	controller.runAction("settings.open");
	controller.addTab(tab("only"));
	for (const callback of deferred.splice(0)) callback();
	controller.toggleZoom();
	const splitPanes = ensureSplitPaneRegistry(scope);
	expect(splitPanes.current()?.size).toBe(Number.MAX_SAFE_INTEGER);
	splitPanes.current()?.onResize?.(37);
	expect(deferred).toHaveLength(1);
	for (const callback of deferred.splice(0)) callback();

	expect(actions).toEqual(["settings.open"]);
	expect(controller.isZoomed()).toBe(false);
	expect(splitPanes.current()?.size).toBe(37);
	controller.dispose();
});
