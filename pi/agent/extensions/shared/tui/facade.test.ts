import { expect, test } from "bun:test";
import { defineExtensionTui, renderView, view } from "./index";

const theme = {
	fg(_role: string, text: string) {
		return text;
	},
};

test("session facade mounts above-editor widgets through shared renderer", () => {
	const mounted: Array<{ key: string; placement?: string; lines: string[] }> = [];
	const extension = defineExtensionTui({ id: "tasks" });
	const session = extension.bind({
		ui: {
			setWidget(key, content, options) {
				if (typeof content !== "function") return;
				const component = content({ requestRender() {} }, theme);
				mounted.push({ key, placement: options?.placement, lines: component.render(24) });
			},
		},
	});

	session.widgets.aboveEditor.contribute({
		id: "project-tasks",
		priority: 10,
		view: view.panel({ title: view.text("Tasks"), children: [view.text("one active task")] }),
	});

	expect(mounted).toEqual([
		{
			key: "tasks:widgets.aboveEditor",
			placement: "aboveEditor",
			lines: ["╭─ Tasks ──────────────╮", "│ one active task      │", "╰──────────────────────╯"],
		},
	]);
});

test("tool renderers registered on global facade return ViewNodes", () => {
	const extension = defineExtensionTui({ id: "exec" });

	extension.tools.register("exec_command", {
		call: ({ args }) => view.panel({ title: view.text("Command"), children: [view.text(String(args.cmd))] }),
	});

	const renderer = extension.tools.resolve("exec_command");
	const node = renderer?.call?.({ args: { cmd: "git status" }, state: "ready" });

	expect(node ? renderView(node, { width: 24, theme }) : []).toEqual([
		"╭─ Command ────────────╮",
		"│ git status           │",
		"╰──────────────────────╯",
	]);
});

test("session facade opens component overlays without direct extension ctx.ui.custom calls", async () => {
	const opened: Array<{ overlay?: boolean; result: string[] }> = [];
	const component = {
		render: (width: number) => [`overlay:${width}`],
		invalidate() {},
	};
	const extension = defineExtensionTui({ id: "prompt-storage" });
	const session = extension.bind({
		ui: {
			setWidget() {},
			async custom(factory, options) {
				const created = factory({ requestRender() {} }, theme, {}, (value) => value);
				opened.push({ overlay: options?.overlay, result: created.render(32) });
				return "picked";
			},
		},
	});

	const result = await session.overlays.openComponent<string>((_tui, _theme, _keybindings, _done) => component, {
		overlay: true,
	});

	expect(result).toBe("picked");
	expect(opened).toEqual([{ overlay: true, result: ["overlay:32"] }]);
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
