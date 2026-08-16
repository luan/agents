import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCodexPluginAliases } from "../codex-native/plugin-aliases";
import { findResources, readResource } from "../shared/resources.ts";
import { findMentionAtCursor, wrapProvider } from "./autocomplete";
import extension from "./index";
import {
	buildItems,
	collectSkills,
	extractDollarSkillReferences,
	rewriteSlashSkillReferences,
	stripFrontmatter,
} from "./skills";

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

describe("skillful editor wrapping", () => {});

describe("skillful skills", () => {
	test("shows skill descriptions in autocomplete", () => {
		const items = buildItems(
			new Map([
				["tdd", [{ name: "tdd", filePath: "/skills/tdd/SKILL.md", description: "Build changes test-first" }]],
			]),
		);

		expect(items[0]?.description).toBe("Build changes test-first");
	});

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

	// Hidden means unlisted, not unreachable. `skill://<name>` is the internal load
	// path, so removing a hidden skill from the map broke it: a live probe spent a
	// cell on `read skill://computer-use` before it could reach the ten working
	// `mcp__computer_use__*` tools.
	test("keeps hidden skills loadable while dropping them from the picker", () => {
		const pi = {
			getCommands: () => [
				{
					source: "skill",
					name: "skill:control-in-app-browser",
					sourceInfo: { path: "/Users/x/.codex/plugins/cache/openai-bundled/browser/1.0.0/skills/SKILL.md" },
				},
			],
		} as never;

		const visible = collectSkills(pi, new Set(["control-in-app-browser"]));

		expect(visible.has("control-in-app-browser")).toBe(true);
		expect(visible.get("control-in-app-browser")?.[0]?.hidden).toBe(true);
		expect(visible.has("browser")).toBe(true);
		expect(buildItems(visible).map((item) => item.value)).toEqual(["$browser"]);
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
				content: `The complete document is below, already in context: skill://tdd. Do not read it again this turn.\n\n<skill name="tdd" location="${skillPath}">\nReferences are relative to ${dir}.\n\n# TDD\n\nUse \`$plan\` after the test loop.\n\n</skill>`,
				details: {
					extension: "skillful",
					kind: "skill-load",
					name: "tdd",
					status: "read",
					filePath: skillPath,
					baseDir: dir,
					tokens: expect.any(Number),
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
		// Both names, so the model cannot read either back: one live turn paid 377 tokens twice and 542 twice.
		expect(message?.content).toContain("already in context: skill://tdd, skill://plan");
		expect(message?.content).toContain("Do not read them again this turn.");
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

	test("reads plugin alias assets from the matching skill", async () => {
		const dir = mkdtempSync(join(tmpdir(), "skillful-resource-alias-"));
		const buildingDir = join(dir, "building");
		const hostingDir = join(dir, "hosting");
		mkdirSync(join(buildingDir, "templates"), { recursive: true });
		mkdirSync(hostingDir, { recursive: true });
		const buildingPath = join(buildingDir, "SKILL.md");
		const hostingPath = join(hostingDir, "SKILL.md");
		writeFileSync(buildingPath, "---\nname: sites-building\n---\n# Building\n");
		writeFileSync(hostingPath, "---\nname: sites-hosting\n---\n# Hosting\n");
		writeFileSync(join(buildingDir, "templates", "example.html"), "<template>building</template>\n");

		const pi = {
			getCommands: () => [
				{ source: "skill", name: "skill:sites:sites-building", sourceInfo: { path: buildingPath } },
				{ source: "skill", name: "skill:sites:sites-hosting", sourceInfo: { path: hostingPath } },
			],
			on() {},
			registerTool() {},
			registerMessageRenderer() {},
			events: { emit() {} },
		};

		extension(pi as never);

		const asset = await readResource("skill://sites/templates/example.html");
		expect(asset.resource).toMatchObject({
			uri: "skill://sites/templates/example.html",
			name: "templates/example.html",
			metadata: {
				skillName: "sites",
				assetPath: "templates/example.html",
				tokens: expect.any(Number),
			},
		});
		expect(asset.content).toContain('<skill-asset name="sites:sites-building" path="templates/example.html"');
		expect(asset.content).toContain("<template>building</template>");
		const resources = await findResources("skill://sites");
		const rootResource = resources.find((resource) => resource.uri === "skill://sites");
		expect(rootResource).toBeDefined();
		expect(rootResource?.size).toBe(
			Buffer.byteLength("---\nname: sites-building\n---\n# Building\n") +
				Buffer.byteLength("---\nname: sites-hosting\n---\n# Hosting\n") +
				Buffer.byteLength("\n\n"),
		);
	});

	test("reads skill root and nested resources", async () => {
		const dir = mkdtempSync(join(tmpdir(), "skillful-resource-"));
		const skillDir = join(dir, "triage");
		mkdirSync(skillDir, { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		const assetPath = join(skillDir, "OUT-OF-SCOPE.md");
		writeFileSync(skillPath, "---\nname: triage\n---\n# Triage\n");
		writeFileSync(assetPath, "# Out of Scope\n");

		const pi = {
			getCommands: () => [{ source: "skill", name: "skill:triage", sourceInfo: { path: skillPath } }],
			on() {},
			registerTool() {},
			registerMessageRenderer() {},
			events: { emit() {} },
		};

		extension(pi as never);

		const root = await readResource("skill://triage");
		expect(root.resource).toMatchObject({
			uri: "skill://triage",
			name: "SKILL.md",
			metadata: {
				skillName: "triage",
				assetPath: "SKILL.md",
				sourcePath: skillPath,
				tokens: expect.any(Number),
			},
		});
		expect(root.content).toContain('<skill name="triage"');
		expect(root.content).toContain("# Triage");
		const explicitRoot = await readResource("skill://triage/SKILL.md");
		expect(explicitRoot.content).toBe(root.content);

		const asset = await readResource("skill://triage/OUT-OF-SCOPE.md");
		expect(asset.resource).toMatchObject({ uri: "skill://triage/OUT-OF-SCOPE.md", name: "OUT-OF-SCOPE.md" });
		expect(asset.content).toContain('<skill-asset name="triage" path="OUT-OF-SCOPE.md"');
		expect(asset.content).toContain("# Out of Scope");

		const exact = await findResources("skill://triage/OUT-OF-SCOPE.md");
		expect(exact.map((resource) => resource.uri)).toEqual(["skill://triage/OUT-OF-SCOPE.md"]);

		const all = await findResources("skill://triage/");
		expect(all.map((resource) => resource.uri).sort()).toEqual(["skill://triage", "skill://triage/OUT-OF-SCOPE.md"]);
	});

	test("reads a skill whose root document is linked outside its installed directory", async () => {
		const dir = mkdtempSync(join(tmpdir(), "skillful-linked-root-"));
		const sourceDir = join(dir, "source");
		const installedDir = join(dir, "installed");
		mkdirSync(sourceDir, { recursive: true });
		mkdirSync(installedDir, { recursive: true });
		const sourcePath = join(sourceDir, "SKILL.md");
		const installedPath = join(installedDir, "SKILL.md");
		const sourceAssetPath = join(sourceDir, "SECRET.md");
		const installedAssetPath = join(installedDir, "SECRET.md");
		writeFileSync(sourcePath, "---\nname: linked\n---\n# Linked\n");
		writeFileSync(sourceAssetPath, "# Secret\n");
		symlinkSync(sourcePath, installedPath);
		symlinkSync(sourceAssetPath, installedAssetPath);

		const pi = {
			getCommands: () => [{ source: "skill", name: "skill:linked", sourceInfo: { path: installedPath } }],
			on() {},
			registerTool() {},
			registerMessageRenderer() {},
			events: { emit() {} },
		};

		extension(pi as never);

		const root = await readResource("skill://linked");
		expect(root.content).toContain("# Linked");
		await expect(readResource("skill://linked/SECRET.md")).rejects.toThrow("Skill asset path must stay under");
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
