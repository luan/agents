import { describe, expect, test } from "bun:test";
import type { SelectionActionRequest } from "pi-libtui/selection";
import { composeAnnotation, selectionOverlayAnchor } from "../src/runtime/annotations.ts";

function request(
	screen: SelectionActionRequest["screen"],
	screenAnchor = screen.end,
	text = "selected",
): SelectionActionRequest {
	return {
		action: "selection.comment",
		text,
		shape: "character",
		logical: screen,
		screen,
		screenAnchor,
	};
}

describe("selection composer placement", () => {
	test("centers on a one-line selection and keeps the endpoint row", () => {
		expect(
			selectionOverlayAnchor(
				request({ start: { row: 4, col: 10 }, end: { row: 4, col: 20 } }, undefined, "0123456789"),
			),
		).toEqual({
			row: 4,
			col: 15,
		});
	});

	test("centers on selected text instead of trailing empty cells", () => {
		expect(
			selectionOverlayAnchor(request({ start: { row: 4, col: 20 }, end: { row: 4, col: 79 } }, undefined, "hello")),
		).toEqual({
			row: 4,
			col: 23,
		});
	});

	test("uses the first visible column for a multi-line selection", () => {
		expect(selectionOverlayAnchor(request({ start: { row: 4, col: 10 }, end: { row: 7, col: 3 } }))).toEqual({
			row: 7,
			col: 10,
		});
	});

	test("reports an empty selection through cursor-local feedback instead of transcript notification", async () => {
		const feedback: Array<{ message: string; kind: "success" | "warning" }> = [];
		const notifications: string[] = [];
		const empty = request({ start: { row: 4, col: 10 }, end: { row: 4, col: 10 } });
		empty.text = "";
		empty.showFeedback = (message) => feedback.push(message);
		const result = await composeAnnotation(
			empty,
			{ mode: "tui", ui: { notify: (message: string) => notifications.push(message) } } as never,
			{} as never,
			{} as never,
		);
		expect(result).toBe(false);
		expect(feedback).toEqual([{ message: "No text selected to annotate.", kind: "warning" }]);
		expect(notifications).toEqual([]);
	});
});
