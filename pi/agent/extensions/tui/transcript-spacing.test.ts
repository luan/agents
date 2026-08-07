import { expect, test } from "bun:test";
import { relaxFullscreenEditorSize } from "./transcript-spacing";

test("lets the fullscreen editor shrink after its footer moves out", () => {
	const editor = { render: () => [] };
	const editorEntry = { component: editor, minSize: 3 };
	const dock = { render: () => [], entries: [editorEntry] };
	const root = { render: () => [], entries: [{ component: dock }] };

	relaxFullscreenEditorSize({ editorContainer: editor, fullscreenLayoutRoot: root });

	expect(editorEntry.minSize).toBe(2);
});
