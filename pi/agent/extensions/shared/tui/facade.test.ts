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
