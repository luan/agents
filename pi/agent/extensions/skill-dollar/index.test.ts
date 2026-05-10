import { describe, expect, test } from "bun:test";
import type { AutocompleteProvider, EditorComponent } from "@earendil-works/pi-tui";
import { findMentionAtCursor, wrapProvider } from "./autocomplete";
import { installEditorHighlight } from "./editor";
import { colorize } from "./highlight";
import extension from "./index";
import { buildItems, rewriteDollarSkillCommand, rewriteSlashSkillReferences, stripFrontmatter } from "./skills";

describe("skill-dollar highlighting", () => {
	test("highlights known dollar and slash skill references", () => {
		const skills = new Set(["tdd", "crit"]);
		expect(colorize("use $tdd then /skill:crit not $missing", skills)).toBe(
			"use \x1b[36m$tdd\x1b[39m then \x1b[36m/skill:crit\x1b[39m not $missing",
		);
	});

	test("preserves ansi escapes around plain text segments", () => {
		const skills = new Set(["tdd"]);
		expect(colorize("\x1b[7muse $tdd\x1b[0m", skills)).toBe("\x1b[7muse \x1b[36m$tdd\x1b[39m\x1b[0m");
	});
});

describe("skill-dollar autocomplete", () => {
	test("detects dollar mention at cursor", () => {
		expect(findMentionAtCursor("please $td", 10)).toEqual({ token: "$td", query: "td" });
		expect(findMentionAtCursor("email$a", 7)).toBeNull();
	});

	test("returns skill suggestions and applies completion", async () => {
		const base: AutocompleteProvider = {
			async getSuggestions() {
				return { items: [{ value: "base", label: "base" }], prefix: "" };
			},
			applyCompletion(lines) {
				return { lines, cursorLine: 0, cursorCol: 0 };
			},
		};
		const wrapped = wrapProvider(base, () => buildItems(new Map([["tdd", "/skills/tdd/SKILL.md"]])));
		const suggestions = await wrapped.getSuggestions(["use $td"], 0, 7, {});
		expect(suggestions?.prefix).toBe("$td");
		expect(suggestions?.items[0]?.value).toBe("$tdd");
		expect(
			wrapped.applyCompletion(["use $td"], 0, 7, suggestions?.items[0] ?? { value: "$tdd", label: "$tdd" }, "$td"),
		).toEqual({
			lines: ["use $tdd"],
			cursorLine: 0,
			cursorCol: 8,
		});
	});
});

describe("skill-dollar editor wrapping", () => {
	test("wraps the existing editor line transform", () => {
		const editor: EditorComponent & { transformEditorLine?: (line: string) => string } = {
			render: () => [],
			invalidate() {},
			transformEditorLine: (line) => `before ${line}`,
		};
		let factory: ((...args: never[]) => EditorComponent) | undefined = () => editor;
		installEditorHighlight(
			{
				getEditorComponent: () => factory as never,
				setEditorComponent: (next) => {
					factory = next as never;
				},
			},
			() => new Set(["tdd"]),
		);

		const nextEditor = factory?.(undefined as never, undefined as never, undefined as never) as typeof editor;
		expect(nextEditor.transformEditorLine?.("$tdd")).toBe("before \x1b[36m$tdd\x1b[39m");
	});
});

describe("skill-dollar skills", () => {
	test("strips yaml frontmatter", () => {
		expect(stripFrontmatter("---\nname: tdd\n---\nbody")).toBe("body");
		expect(stripFrontmatter("body")).toBe("body");
	});

	test("rewrites slash skill references without touching paths", () => {
		const skills = ["implement", "plan"];
		expect(
			rewriteSlashSkillReferences(
				"Use `/implement`, then suggest /plan <research>. Keep ~/blueprints/foo/archive/ unchanged.",
				skills,
			),
		).toBe("Use `$implement`, then suggest $plan <research>. Keep ~/blueprints/foo/archive/ unchanged.");
	});

	test("rewrites leading dollar skill shorthand to native skill command", () => {
		const skills = ["tdd", "crit"];
		expect(rewriteDollarSkillCommand("$tdd fix this", skills)).toBe("/skill:tdd fix this");
		expect(rewriteDollarSkillCommand(" $crit", skills)).toBe("/skill:crit");
		expect(rewriteDollarSkillCommand("please use $tdd", skills)).toBe("please use $tdd");
		expect(rewriteDollarSkillCommand("$missing fix this", skills)).toBe("$missing fix this");
	});
});

describe("skill-dollar extension", () => {
	test("transforms leading dollar shorthand before pi skill expansion", async () => {
		const handlers = new Map<string, Array<(event: { text: string }) => unknown>>();
		const pi = {
			getCommands: () => [
				{ source: "skill", name: "skill:tdd", sourceInfo: { path: "/skills/tdd/SKILL.md" } },
				{ source: "skill", name: "skill:crit", sourceInfo: { path: "/skills/crit/SKILL.md" } },
			],
			on: (event: string, handler: (event: { text: string }) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		};

		extension(pi as never);

		const result = await handlers.get("input")?.[0]?.({ text: "$tdd fix this" });
		expect(result).toEqual({ action: "transform", text: "/skill:tdd fix this" });
		expect(await handlers.get("input")?.[0]?.({ text: "please use $tdd" })).toEqual({ action: "continue" });
	});

	test("reinstalls autocomplete provider after reload", async () => {
		const ui = {
			added: 0,
			addAutocompleteProvider() {
				this.added += 1;
			},
		};
		const createPi = () => {
			const handlers = new Map<
				string,
				Array<(event: { reason?: string }, ctx: { hasUI: boolean; ui: typeof ui }) => unknown>
			>();
			return {
				handlers,
				pi: {
					getCommands: () => [],
					on: (
						event: string,
						handler: (event: { reason?: string }, ctx: { hasUI: boolean; ui: typeof ui }) => unknown,
					) => {
						handlers.set(event, [...(handlers.get(event) ?? []), handler]);
					},
				},
			};
		};

		const first = createPi();
		extension(first.pi as never);
		await first.handlers.get("session_start")?.[0]?.({ reason: "startup" }, { hasUI: true, ui });

		const second = createPi();
		extension(second.pi as never);
		await second.handlers.get("session_start")?.[0]?.({ reason: "reload" }, { hasUI: true, ui });

		expect(ui.added).toBe(2);
	});
});
