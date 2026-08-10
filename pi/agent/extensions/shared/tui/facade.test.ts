import { expect, test } from "bun:test";
import { defineExtensionTui } from "./index";

const theme = {
	fg(_role: string, text: string) {
		return text;
	},
};

test("session facade opens component overlays without direct extension ctx.ui.custom calls", async () => {
	const opened: Array<{ overlay?: boolean }> = [];
	const component = {
		render: (width: number) => [`overlay:${width}`],
		invalidate() {},
	};
	const extension = defineExtensionTui({ id: "prompt-storage" });
	const session = extension.bind({
		ui: {
			setWidget() {},
			async custom(factory, options) {
				factory({ requestRender() {} }, theme, {}, (value) => value);
				opened.push({ overlay: options?.overlay });
				return "picked";
			},
		},
	});

	const result = await session.overlays.openComponent<string>((_tui, _theme, _keybindings, _done) => component, {
		overlay: true,
	});

	expect(result).toBe("picked");
	expect(opened).toEqual([{ overlay: true }]);
});

test("session facade sets status through named Host Surface", () => {
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const extension = defineExtensionTui({ id: "codex-tools" });
	const session = extension.bind({
		ui: {
			setWidget() {},
			setStatus(key, text) {
				statuses.push({ key, text });
			},
		},
	});

	session.status.set("active", "3 tools");
	session.status.clear("active");

	expect(statuses).toEqual([
		{ key: "codex-tools:active", text: "3 tools" },
		{ key: "codex-tools:active", text: undefined },
	]);
});

test("session facade replaces exclusive footer and editor surfaces", () => {
	const calls: Array<{ surface: string; factory: unknown }> = [];
	const extension = defineExtensionTui({ id: "polished-tui" });
	const session = extension.bind({
		ui: {
			setWidget() {},
			setFooter(factory) {
				calls.push({ surface: "footer", factory });
			},
			setEditorComponent(factory) {
				calls.push({ surface: "editor", factory });
			},
		},
	});
	const footerFactory = () => ({ render: () => [], invalidate() {} });
	const editorFactory = () => ({ render: () => [], invalidate() {} });

	session.footer.replace(footerFactory);
	session.editor.replace(editorFactory);

	expect(calls).toEqual([
		{ surface: "footer", factory: footerFactory },
		{ surface: "editor", factory: editorFactory },
	]);
});
