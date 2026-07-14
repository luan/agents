import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteProvider, EditorComponent } from "@earendil-works/pi-tui";
import { setCodexPluginAliases } from "../codex-native/plugin-aliases";
import { findMentionAtCursor, wrapProvider } from "./autocomplete";
import { installEditorHighlight } from "./editor";
import { colorize, colorizeLines } from "./highlight";
import extension from "./index";
import {
	buildItems,
	collectSkills,
	extractDollarSkillReferences,
	rewriteSlashSkillReferences,
	stripFrontmatter,
} from "./skills";
import { highlightTranscriptLines } from "./transcript";

describe("skillful highlighting", () => {
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

	test("does not highlight dollar skills inside quotes or code", () => {
		const skills = new Set(["commit", "diagnose"]);
		expect(colorize("this here: `$commit` but $commit activates", skills)).toBe(
			"this here: `$commit` but \x1b[36m$commit\x1b[39m activates",
		);
		expect(colorize("this$commit stays plain", skills)).toBe("this$commit stays plain");
		expect(colorizeLines(["```", "$diagnose", "```", "$diagnose"], skills)).toEqual([
			"```",
			"$diagnose",
			"```",
			"\x1b[36m$diagnose\x1b[39m",
		]);
	});

	test("does not highlight markdown-rendered ansi code spans or blocks", () => {
		const skills = new Set(["commit", "diagnose"]);
		expect(colorize("\x1b[39mthis here: \x1b[38;2;138;190;183m$commit\x1b[39m but $commit activates", skills)).toBe(
			"\x1b[39mthis here: \x1b[38;2;138;190;183m$commit\x1b[39m but \x1b[36m$commit\x1b[39m activates",
		);
		expect(
			colorizeLines(["\x1b[38;2;128;128;128m```\x1b[39m", "  \x1b[38;2;181;189;104m$diagnose\x1b[39m"], skills),
		).toEqual(["\x1b[38;2;128;128;128m```\x1b[39m", "  \x1b[38;2;181;189;104m$diagnose\x1b[39m"]);
	});
});

describe("skillful transcript highlighting", () => {
	test("does not highlight rendered transcript skills when raw markdown has no activating references", () => {
		const skills = new Set(["commit", "diagnose"]);
		const raw = "humm this here: `$commit`\nthis$commit\n\n```\n$diagnose\n```";
		expect(highlightTranscriptLines([" $commit", "   $diagnose"], raw, skills)).toEqual([" $commit", "   $diagnose"]);
	});

	test("only highlights skills that activate in the raw markdown", () => {
		const skills = new Set(["commit", "diagnose"]);
		const raw = "`$commit` then $diagnose";
		expect(highlightTranscriptLines(["$commit then $diagnose"], raw, skills)).toEqual([
			"$commit then \x1b[36m$diagnose\x1b[39m",
		]);
	});
});

describe("skillful autocomplete", () => {
	test("detects dollar mention at cursor", () => {
		expect(findMentionAtCursor("please $td", 10)).toEqual({ token: "$td", query: "td" });
		expect(findMentionAtCursor("please $sites:", 14)).toEqual({ token: "$sites:", query: "sites:" });
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
		const wrapped = wrapProvider(base, () =>
			buildItems(new Map([["tdd", [{ name: "tdd", filePath: "/skills/tdd/SKILL.md" }]]])),
		);
		expect((wrapped as AutocompleteProvider & { triggerCharacters?: string[] }).triggerCharacters).toEqual(["$"]);
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

describe("skillful editor wrapping", () => {
	test("wraps the existing editor line transform", () => {
		const editor: EditorComponent & { transformEditorLine?: (line: string) => string } = {
			render() {
				return [this.transformEditorLine?.("$tdd") ?? "$tdd"];
			},
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
		expect(nextEditor.render(80)).toEqual(["before \x1b[36m$tdd\x1b[39m"]);
	});

	test("wraps editor render output when line transform is unavailable", () => {
		const editor: EditorComponent = {
			render: () => ["use $tdd"],
			invalidate() {},
			getText: () => "",
			setText() {},
			handleInput() {},
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

		const nextEditor = factory?.(undefined as never, undefined as never, undefined as never);
		expect(nextEditor?.render(80)).toEqual(["use \x1b[36m$tdd\x1b[39m"]);
	});

	test("does not highlight editor dollar skills inside fenced code", () => {
		const editor: EditorComponent = {
			render: () => ["```", "$tdd", "```", "$tdd"],
			invalidate() {},
			getText: () => "",
			setText() {},
			handleInput() {},
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

		const nextEditor = factory?.(undefined as never, undefined as never, undefined as never);
		expect(nextEditor?.render(80)).toEqual(["```", "$tdd", "```", "\x1b[36m$tdd\x1b[39m"]);
	});

	test("does not highlight transformed editor lines inside fenced code", () => {
		const editor: EditorComponent & { transformEditorLine?: (line: string) => string } = {
			render() {
				return ["```", "$tdd", "```", "$tdd"].map((line) => this.transformEditorLine?.(line) ?? line);
			},
			invalidate() {},
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

		const nextEditor = factory?.(undefined as never, undefined as never, undefined as never);
		expect(nextEditor?.render(80)).toEqual(["```", "$tdd", "```", "\x1b[36m$tdd\x1b[39m"]);
	});

	test("wraps editors installed after highlight setup", () => {
		let factory: ((...args: never[]) => EditorComponent) | undefined;
		const ui = {
			getEditorComponent: () => factory,
			setEditorComponent: (next: typeof factory) => {
				factory = next;
			},
		};
		installEditorHighlight(ui, () => new Set(["tdd"]));

		const editor: EditorComponent = {
			render: () => ["use $tdd"],
			invalidate() {},
			getText: () => "",
			setText() {},
			handleInput() {},
		};
		ui.setEditorComponent(() => editor);

		const nextEditor = factory?.(undefined as never, undefined as never, undefined as never);
		expect(nextEditor?.render(80)).toEqual(["use \x1b[36m$tdd\x1b[39m"]);
	});
});

describe("skillful skills", () => {
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

	test("extracts only known unquoted dollar skill references at token starts", () => {
		const skills = new Set(["tdd", "plan", "crit", "sites:sites-building"]);
		expect(
			extractDollarSkillReferences('$missing "$tdd" ` $plan` prefix:$crit path/$tdd\n$crit and $tdd', skills),
		).toEqual(["crit", "tdd"]);
		expect(extractDollarSkillReferences("don't break $plan", skills)).toEqual(["plan"]);
		expect(extractDollarSkillReferences("' $plan' then $tdd", skills)).toEqual(["tdd"]);
		expect(extractDollarSkillReferences("use $sites:sites-building", skills)).toEqual(["sites:sites-building"]);
	});
});

describe("skillful extension", () => {
	test("adds a plugin alias for qualified skills", () => {
		setCodexPluginAliases([]);
		const skills = collectSkills({
			getCommands: () => [
				{ source: "skill", name: "skill:sites:sites-building", sourceInfo: { path: "/sites/building/SKILL.md" } },
				{ source: "skill", name: "skill:sites:sites-hosting", sourceInfo: { path: "/sites/hosting/SKILL.md" } },
			],
		} as never);

		expect(skills.get("sites")).toEqual([
			{ name: "sites:sites-building", filePath: "/sites/building/SKILL.md" },
			{ name: "sites:sites-hosting", filePath: "/sites/hosting/SKILL.md" },
		]);
		expect(buildItems(skills).map((item) => item.value)).toEqual([
			"$sites:sites-building",
			"$sites:sites-hosting",
			"$sites",
		]);
	});

	test("adds a plugin alias for skills loaded from the Codex cache", () => {
		const skills = collectSkills({
			getCommands: () => [
				{
					source: "skill",
					name: "skill:sites-building",
					sourceInfo: {
						path: "/home/test/.codex/plugins/cache/openai-bundled/sites/0.1.27/skills/sites-building/SKILL.md",
					},
				},
				{
					source: "skill",
					name: "skill:sites-hosting",
					sourceInfo: {
						path: "/home/test/.codex/plugins/cache/openai-bundled/sites/0.1.27/skills/sites-hosting/SKILL.md",
					},
				},
			],
		} as never);

		expect(skills.get("sites")).toEqual([
			{
				name: "sites-building",
				filePath: "/home/test/.codex/plugins/cache/openai-bundled/sites/0.1.27/skills/sites-building/SKILL.md",
			},
			{
				name: "sites-hosting",
				filePath: "/home/test/.codex/plugins/cache/openai-bundled/sites/0.1.27/skills/sites-hosting/SKILL.md",
			},
		]);
	});

	test("hides configured skills from autocomplete while keeping plugin aliases visible", () => {
		const skills = new Map([
			["browser", [{ name: "browser:control-in-app-browser", filePath: "/browser/SKILL.md" }]],
			["control-in-app-browser", [{ name: "control-in-app-browser", filePath: "/browser/SKILL.md" }]],
		]);

		expect(buildItems(skills, new Set(["control-in-app-browser"])).map((item) => item.value)).toEqual(["$browser"]);
		expect(skills.has("control-in-app-browser")).toBe(true);
	});

	test("loads all plugin skills through the plugin alias", async () => {
		const dir = mkdtempSync(join(tmpdir(), "skillful-plugin-"));
		const cacheSkillsDir = join(dir, ".codex", "plugins", "cache", "openai-bundled", "sites", "0.1.27", "skills");
		mkdirSync(cacheSkillsDir, { recursive: true });
		const buildingPath = join(cacheSkillsDir, "sites-building", "SKILL.md");
		const hostingPath = join(cacheSkillsDir, "sites-hosting", "SKILL.md");
		mkdirSync(join(cacheSkillsDir, "sites-building"), { recursive: true });
		mkdirSync(join(cacheSkillsDir, "sites-hosting"), { recursive: true });
		writeFileSync(buildingPath, "---\nname: sites-building\n---\n# Build with Sites\n");
		writeFileSync(hostingPath, "---\nname: sites-hosting\n---\n# Host with Sites\n");
		const handlers = new Map<string, Array<(event: { prompt: string }) => unknown>>();
		const pi = {
			getCommands: () => [
				{ source: "skill", name: "skill:sites-building", sourceInfo: { path: buildingPath } },
				{ source: "skill", name: "skill:sites-hosting", sourceInfo: { path: hostingPath } },
			],
			on: (event: string, handler: (event: { prompt: string }) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerMessageRenderer() {},
			events: { emit() {} },
		};

		extension(pi as never);
		const result = await handlers.get("before_agent_start")?.[0]?.({ prompt: "$sites build a site" });
		const message = (
			result as { message?: { content?: string; details?: { loads?: Array<{ name: string }> } } } | undefined
		)?.message;

		expect(message?.content).toContain("# Build with Sites");
		expect(message?.content).toContain("# Host with Sites");
		expect(message?.details?.loads?.map((load) => load.name)).toEqual(["sites-building", "sites-hosting"]);
	});

	test("does not visually rewrite leading dollar shorthand", async () => {
		const handlers = new Map<string, Array<(event: { text: string }) => unknown>>();
		const pi = {
			getCommands: () => [
				{ source: "skill", name: "skill:tdd", sourceInfo: { path: "/skills/tdd/SKILL.md" } },
				{ source: "skill", name: "skill:crit", sourceInfo: { path: "/skills/crit/SKILL.md" } },
			],
			on: (event: string, handler: (event: { text: string }) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerMessageRenderer() {},
			events: { emit() {} },
		};

		extension(pi as never);

		expect(handlers.has("input")).toBe(false);
	});

	test("loads referenced dollar skills as custom messages before agent start", async () => {
		const dir = mkdtempSync(join(tmpdir(), "skillful-"));
		const skillPath = join(dir, "SKILL.md");
		writeFileSync(skillPath, "---\nname: tdd\n---\n# TDD\n\nUse `/plan` after the test loop.\n");

		const handlers = new Map<
			string,
			Array<(event: { prompt: string; systemPrompt: string }, ctx: unknown) => unknown>
		>();
		const pi = {
			getCommands: () => [
				{ source: "skill", name: "skill:tdd", sourceInfo: { path: skillPath } },
				{ source: "skill", name: "skill:plan", sourceInfo: { path: "/skills/plan/SKILL.md" } },
			],
			on: (event: string, handler: (event: { prompt: string; systemPrompt: string }, ctx: unknown) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerMessageRenderer() {},
			events: { emit() {} },
		};

		extension(pi as never);

		const result = await handlers.get("before_agent_start")?.[0]?.(
			{
				prompt: "$tdd $tdd\n\nfix this",
				systemPrompt: "base",
			},
			{ sessionManager: { getBranch: () => [] } },
		);
		expect(result).toEqual({
			message: {
				customType: "skillful-load",
				display: true,
				content: `<skill name="tdd" location="${skillPath}">\nReferences are relative to ${dir}.\n\n# TDD\n\nUse \`$plan\` after the test loop.\n\n</skill>`,
				details: {
					extension: "skillful",
					kind: "skill-load",
					name: "tdd",
					status: "read",
					filePath: skillPath,
					baseDir: dir,
				},
			},
		});
	});

	test("loads multiple referenced dollar skills in one custom message", async () => {
		const dir = mkdtempSync(join(tmpdir(), "skillful-"));
		const tddPath = join(dir, "tdd.md");
		const planPath = join(dir, "plan.md");
		writeFileSync(tddPath, "---\nname: tdd\n---\n# TDD\n");
		writeFileSync(planPath, "---\nname: plan\n---\n# Plan\n");

		const handlers = new Map<
			string,
			Array<(event: { prompt: string; systemPrompt: string }, ctx: unknown) => unknown>
		>();
		const pi = {
			getCommands: () => [
				{ source: "skill", name: "skill:tdd", sourceInfo: { path: tddPath } },
				{ source: "skill", name: "skill:plan", sourceInfo: { path: planPath } },
			],
			on: (event: string, handler: (event: { prompt: string; systemPrompt: string }, ctx: unknown) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerMessageRenderer() {},
			events: { emit() {} },
		};

		extension(pi as never);

		const result = await handlers.get("before_agent_start")?.[0]?.(
			{
				prompt: "$tdd then $plan",
				systemPrompt: "base",
			},
			{ sessionManager: { getBranch: () => [] } },
		);

		const message = (result as { message?: { content?: string; details?: { loads?: unknown[] } } } | undefined)
			?.message;
		expect(message?.content).toContain('<skill name="tdd"');
		expect(message?.content).toContain('<skill name="plan"');
		expect(message?.details?.loads).toHaveLength(2);
	});

	test("ignores unknown dollar skill references", async () => {
		const handlers = new Map<
			string,
			Array<(event: { prompt: string; systemPrompt: string }, ctx: unknown) => unknown>
		>();
		const pi = {
			getCommands: () => [],
			on: (event: string, handler: (event: { prompt: string; systemPrompt: string }, ctx: unknown) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerMessageRenderer() {},
			events: { emit() {} },
		};

		extension(pi as never);

		const result = await handlers.get("before_agent_start")?.[0]?.(
			{
				prompt: "$missing fix this",
				systemPrompt: "base",
			},
			{ sessionManager: { getBranch: () => [] } },
		);
		expect(result).toBeUndefined();
	});

	test("registers skill tool with read results", async () => {
		const dir = mkdtempSync(join(tmpdir(), "skillful-"));
		const skillPath = join(dir, "SKILL.md");
		writeFileSync(skillPath, "---\nname: tdd\n---\n# TDD\n\nUse `/plan` after the test loop.\n");

		const tools: Array<{
			name: string;
			renderCall?: (
				args: { name: string },
				theme: typeof theme,
				context: { isPartial?: boolean },
			) => {
				render: (width: number) => string[];
			};
			renderResult?: (
				result: { details?: unknown; content: unknown[] },
				options: unknown,
				theme: typeof theme,
			) => {
				render: (width: number) => string[];
			};
			execute: (
				id: string,
				params: { name: string },
				signal?: AbortSignal,
				onUpdate?: unknown,
				ctx?: unknown,
			) => Promise<{
				content: Array<{ type: "text"; text: string }>;
				details: unknown;
			}>;
		}> = [];
		const pi = {
			getCommands: () => [
				{ source: "skill", name: "skill:tdd", sourceInfo: { path: skillPath } },
				{ source: "skill", name: "skill:plan", sourceInfo: { path: "/skills/plan/SKILL.md" } },
			],
			on() {},
			registerTool: (tool: never) => tools.push(tool),
			registerMessageRenderer() {},
			events: { emit() {} },
		};

		extension(pi as never);

		const tool = tools.find((candidate) => candidate.name === "skill");
		expect(tool).toBeTruthy();
		const ctx = { sessionManager: { getBranch: () => [] } };
		const first = await tool?.execute("call-1", { name: "tdd" }, undefined, undefined, ctx);
		expect(first?.content[0]?.text).toContain("# TDD");
		expect(first?.content[0]?.text).toContain("Use `$plan` after the test loop.");
		expect(first?.details).toMatchObject({ extension: "skillful", kind: "skill-load", name: "tdd", status: "read" });

		const second = await tool?.execute("call-2", { name: "tdd" }, undefined, undefined, ctx);
		expect(second?.content[0]?.text).toContain("# TDD");
		expect(second?.content[0]?.text).toContain("Use `$plan` after the test loop.");
		expect(second?.details).toMatchObject({ extension: "skillful", kind: "skill-load", name: "tdd", status: "read" });
		await expect(tool?.execute("call-3", { name: "missing" }, undefined, undefined, ctx)).rejects.toThrow(
			'Unknown skill "missing"',
		);

		const theme = {
			fg: (_role: string, text: string) => text,
			bold: (text: string) => text,
		};
		expect(
			tool
				?.renderResult?.({ content: [], details: second?.details }, { expanded: false }, theme)
				?.render(80)[0]
				?.trim(),
		).toBe("Skill - tdd read");
		expect(tool?.renderCall?.({ name: "tdd" }, theme, { isPartial: false })?.render(80)).toEqual([]);
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
					registerTool() {},
					registerMessageRenderer() {},
					events: { emit() {} },
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
