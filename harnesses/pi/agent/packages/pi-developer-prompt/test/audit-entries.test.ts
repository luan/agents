import { expect, test } from "bun:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type ComponentStack, configureTuiAppearance, icon, tuiTheme } from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import {
	DEVELOPER_AUDIT_ENTRY_TYPE,
	PROMPT_AUDIT_GROUP_ENTRY_TYPE,
	registerPromptAuditEntryRenderers,
} from "../src/audit-entries.ts";

function stripAnsi(value: string): string {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

test("renders Markdown through pi-libtui semantic colors", () => {
	let renderer: ((entry: { data: object }, options: { expanded: boolean }, theme: Theme) => Component) | undefined;
	let groupRenderer: typeof renderer;
	registerPromptAuditEntryRenderers({
		registerEntryRenderer(customType, next) {
			if (customType === DEVELOPER_AUDIT_ENTRY_TYPE) renderer = next as typeof renderer;
			if (customType === PROMPT_AUDIT_GROUP_ENTRY_TYPE) groupRenderer = next as typeof renderer;
		},
	} as Pick<ExtensionAPI, "registerEntryRenderer">);
	if (!renderer) throw new Error("developer audit renderer was not registered");

	const theme = {
		name: "audit-test",
		getColorMode: () => "truecolor",
		getFgAnsi: (token: string) =>
			({
				error: "\x1b[38;2;247;118;142m",
				success: "\x1b[38;2;158;206;106m",
				warning: "\x1b[38;2;224;175;104m",
				accent: "\x1b[38;2;122;162;247m",
				border: "\x1b[38;2;59;66;97m",
				mdHeading: "\x1b[38;2;255;158;100m",
				syntaxKeyword: "\x1b[38;2;187;154;247m",
				mdLink: "\x1b[38;2;125;207;255m",
				muted: "\x1b[38;2;86;95;137m",
				dim: "\x1b[38;2;59;66;97m",
				text: "\x1b[38;2;220;220;220m",
			})[token] ?? "\x1b[39m",
		getBgAnsi: () => "\x1b[48;2;26;27;38m",
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
		underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
	} as never as Theme;
	const component = renderer(
		{
			data: { role: "developer", id: "example", content: "# Heading\n\n[Link](https://example.com) and `code`." },
		},
		{ expanded: true },
		theme,
	);
	const rendered = component.render(80).join("\n");
	const colors = tuiTheme(theme);

	expect(stripAnsi(rendered)).toContain(`developer · example ${icon("expand-open")}`);
	expect(rendered).toContain("Heading");
	expect(rendered).toContain(colors.fgAnsi("heading"));
	expect(rendered).toContain(colors.fgAnsi("accent"));
	expect(rendered).toContain(colors.fgAnsi("warning"));

	if (!groupRenderer) throw new Error("prompt audit group renderer was not registered");
	configureTuiAppearance({ iconPack: "nerd-fonts" });
	const group = groupRenderer(
		{
			data: {
				entries: [
					{ role: "developer", id: "tool-guidelines", content: "Developer guidance." },
					{ role: "developer", id: "environment", content: "Environment guidance." },
					{ role: "user", id: "agents-md", content: "Project rules." },
				],
			},
		},
		{ expanded: false },
		theme,
	);
	const compact = group.render(80).map((line) => stripAnsi(line).trimEnd());
	expect(compact).toHaveLength(3);
	expect(compact.join("\n")).not.toContain("Developer guidance.");
	expect(compact[0]).toMatch(
		new RegExp(`^󱔘 developer · tool-guidelines\\s+${escapeRegExp(icon("expand-closed"))}$`, "u"),
	);
	expect(compact[1]).toMatch(new RegExp(`^󱔘 developer · environment\\s+${escapeRegExp(icon("expand-closed"))}$`, "u"));
	expect(compact[2]).toMatch(new RegExp(`^󰷈 user · agents-md\\s+${escapeRegExp(icon("expand-closed"))}$`, "u"));
	const grouped = group as ComponentStack;
	for (const row of [0, 1, 2]) {
		expect(
			grouped.onMouse({
				type: "move",
				row,
				col: 79,
				screenRow: row,
				screenCol: 79,
				button: undefined,
				wheel: undefined,
				shift: false,
				alt: false,
				ctrl: false,
			}),
		).toBe(true);
		expect(grouped.render(80).map((line) => line.includes(colors.bgAnsi("surface.hover")))).toEqual(
			[0, 1, 2].map((index) => index === row),
		);
		grouped.onMouse({
			type: "leave",
			row,
			col: 79,
			screenRow: row,
			screenCol: 79,
			button: undefined,
			wheel: undefined,
			shift: false,
			alt: false,
			ctrl: false,
		});
	}
	const firstRow = grouped.getChildren()[0] as Component & {
		children: readonly Component[];
		render(width: number): string[];
	};
	const header = firstRow.children[0] as Component & {
		onMouse(event: TuiMouseEvent): boolean;
	};
	firstRow.render(80);
	header.onMouse({
		type: "press",
		row: 0,
		col: 0,
		screenRow: 0,
		screenCol: 0,
		button: 0,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	});
	header.onMouse({
		type: "release",
		row: 0,
		col: 0,
		screenRow: 0,
		screenCol: 0,
		button: 0,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	});
	expect(group.render(80).join("\n")).toContain("Developer guidance.");
	const body = firstRow.children[1] as Component & {
		onMouse(event: TuiMouseEvent): boolean;
	};
	const expanded = firstRow.render(80);
	const bodyClick = {
		type: "press" as const,
		row: 1,
		col: 4,
		screenRow: 1,
		screenCol: 4,
		button: 0 as const,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
	const bodyRelease = { ...bodyClick, type: "release" as const };
	expect(body.onMouse(bodyClick)).toBe(false);
	expect(body.onMouse(bodyRelease)).toBe(false);
	expect(firstRow.render(80)).toEqual(expanded);
	header.onMouse({ ...bodyClick, row: 0, screenRow: 0, col: 0, screenCol: 0 });
	header.onMouse({ ...bodyRelease, row: 0, screenRow: 0, col: 0, screenCol: 0 });
	expect(firstRow.render(80)).toHaveLength(1);
	header.onMouse({ ...bodyClick, row: 0, screenRow: 0, col: 0, screenCol: 0 });
	header.onMouse({ ...bodyRelease, row: 0, screenRow: 0, col: 0, screenCol: 0 });
	header.onMouse({ ...bodyClick, row: 0, screenRow: 0, col: 0, screenCol: 0, button: 2 });
	header.onMouse({ ...bodyRelease, row: 0, screenRow: 0, col: 0, screenCol: 0, button: 2 });
	expect(firstRow.render(80)).toHaveLength(1);
	configureTuiAppearance({ iconPack: "unicode" });
});

test("keeps prompt audit bodies inside a 20-row fold viewport", () => {
	let renderer: ((entry: { data: object }, options: { expanded: boolean }, theme: Theme) => Component) | undefined;
	registerPromptAuditEntryRenderers({
		registerEntryRenderer(customType, next) {
			if (customType === DEVELOPER_AUDIT_ENTRY_TYPE) renderer = next as typeof renderer;
		},
	} as Pick<ExtensionAPI, "registerEntryRenderer">);
	if (!renderer) throw new Error("developer audit renderer was not registered");

	const component = renderer(
		{
			data: {
				role: "developer",
				id: "large",
				content: Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"),
			},
		},
		{ expanded: false },
		minimalTheme(),
	);
	const activity = component as Component & {
		children: readonly Component[];
		render(width: number): string[];
	};
	const action = activity.children[0] as Component & { onMouse(event: TuiMouseEvent): boolean };
	activity.render(80);
	action.onMouse(mouse("press", 0, 0, 0));
	action.onMouse(mouse("release", 0, 0, 0));
	const expanded = activity.render(80);
	expect(expanded).toHaveLength(20);
	expect(expanded.join("\n")).toContain("line 18");
	expect(expanded.join("\n")).not.toContain("line 19");
	const body = activity.children[1] as Component & { onMouse(event: TuiMouseEvent): boolean };
	expect(
		body.onMouse({
			type: "wheel",
			row: 18,
			col: 4,
			screenRow: 18,
			screenCol: 4,
			button: undefined,
			wheel: 1,
			shift: false,
			alt: false,
			ctrl: false,
		}),
	).toBe(true);
	const scrolled = activity.render(80).join("\n");
	expect(scrolled).toContain("line 21");
	expect(scrolled).not.toContain("line 0");
});

function minimalTheme(): Theme {
	return {
		name: "audit-behavior-test",
		getColorMode: () => "truecolor",
		getFgAnsi: () => "\x1b[39m",
		getBgAnsi: () => "\x1b[48;2;30;30;30m",
	} as never as Theme;
}

function mouse(type: "press" | "release", row: number, col: number, button: 0 | 2) {
	return {
		type,
		row,
		col,
		screenRow: row,
		screenCol: col,
		button,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
