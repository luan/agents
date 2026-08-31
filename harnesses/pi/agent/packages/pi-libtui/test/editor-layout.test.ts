import { describe, expect, test } from "bun:test";
import { Container, type Component, type TUI, VStack } from "@earendil-works/pi-tui";
import { installEditorMinimumRows } from "../src/editor/layout.ts";

function rows(...lines: string[]): Component {
	return { render: () => lines, invalidate() {} };
}

describe("editor layout", () => {
	test("removes Pi's reserved border row for a borderless editor and restores it on dispose", () => {
		const editor = rows("transition", "prompt");
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const dock = new VStack([
			{ component: editorContainer, minSize: 3 },
			{ component: rows("footer"), minSize: 1 },
		]);
		let renders = 0;
		const tui = { layoutRoot: dock, requestRender: () => renders++ } as never as TUI;
		const lease = installEditorMinimumRows(tui, 2);

		expect(dock.render(80)).toEqual(["transition", "prompt", "", "footer"]);
		lease.reconcile(editor);
		expect(dock.render(80)).toEqual(["transition", "prompt", "footer"]);

		lease.dispose();
		expect(dock.render(80)).toEqual(["transition", "prompt", "", "footer"]);
		expect(renders).toBe(1);
	});
});
