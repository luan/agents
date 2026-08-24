import { describe, expect, test } from "bun:test";
import { ensureSelectionRegistry } from "../../src/selection.ts";

describe("selection registry", () => {
	test("publishes to optional listeners and disposes by identity", () => {
		const scope = Object.create(null) as typeof globalThis;
		const registry = ensureSelectionRegistry(scope);
		const rows: number[] = [];
		const remove = registry.onSelectionCompleted((selection) => rows.push(selection.logical.start.row));
		registry.publishSelectionCompleted({
			text: "selected",
			shape: "character",
			logical: { start: { row: 3, col: 0 }, end: { row: 3, col: 8 } },
			screen: { start: { row: 3, col: 0 }, end: { row: 3, col: 8 } },
		});
		expect(rows).toEqual([3]);
		remove();
		registry.publishSelectionCompleted({
			text: "ignored",
			shape: "line",
			logical: { start: { row: 4, col: 0 }, end: { row: 4, col: 8 } },
			screen: { start: { row: 4, col: 0 }, end: { row: 4, col: 8 } },
		});
		expect(rows).toEqual([3]);
	});

	test("isolates action listener failures and reports whether one handled the request", async () => {
		const registry = ensureSelectionRegistry(Object.create(null) as typeof globalThis);
		registry.onSelectionAction(() => {
			throw new Error("optional listener failed");
		});
		registry.onSelectionAction(async () => true);

		await expect(
			registry.publishSelectionAction({
				action: "selection.comment",
				text: "selected",
				shape: "character",
				logical: { start: { row: 1, col: 0 }, end: { row: 1, col: 8 } },
				screen: { start: { row: 1, col: 0 }, end: { row: 1, col: 8 } },
			}),
		).resolves.toBe(true);
	});
});
