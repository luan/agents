import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import gitToolExtension, {
	appendGitToolPrompt,
	GIT_TOOL_GIT_SPICE_PROMPT_ADDENDUM,
	GIT_TOOL_GRAPHITE_PROMPT_ADDENDUM,
	GIT_TOOL_MAIN_PROMPT_ADDENDUM,
	gitToolResources,
	gitToolToolCallBlock,
	parseGitToolMode,
} from "./index";

type Handler = (...args: any[]) => unknown;

function createPi(configValue: string | undefined, currentBranch = "feature", trunkBranch = "main") {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};

	gitToolExtension(pi as any, {
		readCurrentBranch: () => currentBranch,
		readGitToolConfig: () => configValue,
		readTrunkBranch: () => trunkBranch,
	});

	return { handlers };
}

function toolCall(toolName: string, command?: string) {
	return {
		toolName,
		input: command === undefined ? {} : { command },
	};
}

describe("git-tool mode parsing", () => {
	test.each([
		["graphite", "graphite"],
		["git-spice", "git-spice"],
		["main", "main"],
		["none", "none"],
		[undefined, "none"],
		["", "none"],
		[" Graphite ", "none"],
		["unknown", "none"],
	])("parses %p as %p", (input, expected) => {
		expect(parseGitToolMode(input)).toBe(expected);
	});
});

describe("git-tool resources", () => {
	test("graphite mode contributes exactly the Graphite generic skill directory", () => {
		const resources = gitToolResources("graphite");

		expect(resources.skillPaths?.map((path) => basename(path))).toEqual(["graphite"]);
		expect(resources.skillPaths?.[0]).toContain("git-tool/skill-resources/graphite");
	});

	test("git-spice mode contributes exactly the Git-Spice generic skill directory", () => {
		const resources = gitToolResources("git-spice");

		expect(resources.skillPaths?.map((path) => basename(path))).toEqual(["git-spice"]);
		expect(resources.skillPaths?.[0]).toContain("git-tool/skill-resources/git-spice");
	});

	test("main mode contributes no skill paths", () => {
		expect(gitToolResources("main")).toEqual({});
	});

	test("none mode contributes no skill paths", () => {
		expect(gitToolResources("none")).toEqual({});
	});
});

describe("git-tool prompt addendum", () => {
	test("graphite mode adds strict stack workflow guidance", () => {
		const prompt = appendGitToolPrompt("base", "graphite");

		expect(prompt).toContain(GIT_TOOL_GRAPHITE_PROMPT_ADDENDUM);
		expect(prompt).toContain("Do not use raw `git push`");
		expect(prompt).toContain("Use the `submit`, `sync`, `restack`, and `stack` skills");
	});

	test("git-spice mode adds strict stack workflow guidance", () => {
		const prompt = appendGitToolPrompt("base", "git-spice");

		expect(prompt).toContain(GIT_TOOL_GIT_SPICE_PROMPT_ADDENDUM);
		expect(prompt).toContain("Do not use raw `git push`");
		expect(prompt).toContain("Use the `submit`, `sync`, `restack`, and `stack` skills");
	});

	test("main mode adds current-branch commit and push guidance", () => {
		const prompt = appendGitToolPrompt("base", "main");

		expect(prompt).toContain("base");
		expect(prompt).toContain(GIT_TOOL_MAIN_PROMPT_ADDENDUM);
		expect(prompt).toContain("currently checked-out branch");
	});

	test("main prompt addendum is idempotent", () => {
		const once = appendGitToolPrompt("base", "main");
		expect(appendGitToolPrompt(once, "main")).toBe(once);
	});

	test("graphite prompt addendum is idempotent", () => {
		const once = appendGitToolPrompt("base", "graphite");
		expect(appendGitToolPrompt(once, "graphite")).toBe(once);
	});

	test("git-spice prompt addendum is idempotent", () => {
		const once = appendGitToolPrompt("base", "git-spice");
		expect(appendGitToolPrompt(once, "git-spice")).toBe(once);
	});

	test("none mode leaves system prompt unchanged", () => {
		expect(appendGitToolPrompt("base", "none")).toBe("base");
	});
});

describe("Git-Spice skills", () => {
	test("exposes generic skill names only", () => {
		const skillDir = gitToolResources("git-spice").skillPaths?.[0];
		if (!skillDir) throw new Error("missing Git-Spice skill directory");

		expect(skillDirectoryNames(skillDir)).toEqual(["restack", "stack", "submit", "sync"]);
	});

	test("documents Git-Spice branch creation commands and shorthands", () => {
		const skillDir = gitToolResources("git-spice").skillPaths?.[0];
		if (!skillDir) throw new Error("missing Git-Spice skill directory");

		const stack = readFileSync(`${skillDir}/stack/SKILL.md`, "utf8");

		expect(stack).toContain("name: stack");
		expect(stack).toContain("gs branch create");
		expect(stack).toContain("gs bc");
		expect(stack).not.toContain("name: gs");
	});

	test("documents Git-Spice submit command contracts without requiring the binary", () => {
		const skillDir = gitToolResources("git-spice").skillPaths?.[0];
		if (!skillDir) throw new Error("missing Git-Spice skill directory");

		const submit = readFileSync(`${skillDir}/submit/SKILL.md`, "utf8");

		expect(submit).toContain("gs stack submit");
		expect(submit).toContain("gs ss");
		expect(submit).toContain("update existing Change Requests");
	});
});

describe("git-tool trunk side-effect gate", () => {
	test.each([
		"apply_patch",
		"functions.apply_patch",
		"edit",
		"write",
		"exec_command",
		"bash",
		"functions.exec_command",
	])("blocks %s on trunk in Graphite mode", (toolName) => {
		expect(
			gitToolToolCallBlock(toolCall(toolName), { mode: "graphite", currentBranch: "main", trunkBranch: "main" }),
		).toEqual({
			block: true,
			reason: expect.stringContaining("agents.git-tool=graphite"),
		});
	});

	test("blocks side-effect tools on trunk in Git-Spice mode", () => {
		expect(
			gitToolToolCallBlock(toolCall("apply_patch"), {
				mode: "git-spice",
				currentBranch: "main",
				trunkBranch: "main",
			}),
		).toEqual({
			block: true,
			reason: expect.stringContaining("agents.git-tool=git-spice"),
		});
	});

	test("allows side-effect tools on non-trunk branches", () => {
		expect(
			gitToolToolCallBlock(toolCall("apply_patch"), {
				mode: "graphite",
				currentBranch: "feature",
				trunkBranch: "main",
			}),
		).toBeUndefined();
	});

	test("allows side-effect tools while detached during stack operations", () => {
		expect(
			gitToolToolCallBlock(toolCall("apply_patch"), {
				mode: "graphite",
				currentBranch: "(detached)",
				trunkBranch: "main",
			}),
		).toBeUndefined();
	});

	test.each(["main", "none"] as const)("does not activate in %s mode", (mode) => {
		expect(
			gitToolToolCallBlock(toolCall("apply_patch"), { mode, currentBranch: "main", trunkBranch: "main" }),
		).toBeUndefined();
	});

	test("allows safe read-only git inspection shell commands on trunk", () => {
		for (const command of [
			"git status",
			"git branch --show-current",
			"git rev-parse --show-toplevel",
			"git symbolic-ref --short HEAD",
			"git config --get agents.git-tool",
			"gt trunk",
			"gs trunk -n",
		]) {
			expect(
				gitToolToolCallBlock(toolCall("exec_command", command), {
					mode: command.startsWith("gs ") ? "git-spice" : "graphite",
					currentBranch: "main",
					trunkBranch: "main",
				}),
			).toBeUndefined();
		}
	});

	test("allows trunk query commands before branch state is known", () => {
		expect(gitToolToolCallBlock(toolCall("exec_command", "gt trunk"), { mode: "graphite" })).toBeUndefined();
		expect(gitToolToolCallBlock(toolCall("exec_command", "gs trunk -n"), { mode: "git-spice" })).toBeUndefined();
	});

	test("allows configured tool branch creation commands on trunk", () => {
		expect(
			gitToolToolCallBlock(toolCall("exec_command", "gt create luan/feature"), {
				mode: "graphite",
				currentBranch: "main",
				trunkBranch: "main",
			}),
		).toBeUndefined();
		expect(
			gitToolToolCallBlock(toolCall("exec_command", "gs branch create luan/feature"), {
				mode: "git-spice",
				currentBranch: "main",
				trunkBranch: "main",
			}),
		).toBeUndefined();
		expect(
			gitToolToolCallBlock(toolCall("exec_command", "gs bc luan/feature"), {
				mode: "git-spice",
				currentBranch: "main",
				trunkBranch: "main",
			}),
		).toBeUndefined();
	});

	test("blocks shell commands that are not whitelisted on trunk", () => {
		expect(
			gitToolToolCallBlock(toolCall("exec_command", "git push"), {
				mode: "graphite",
				currentBranch: "main",
				trunkBranch: "main",
			}),
		).toEqual({
			block: true,
			reason: expect.stringContaining("Start a stack branch first"),
		});
	});

	test("fails closed when the selected tool cannot report trunk state", () => {
		expect(gitToolToolCallBlock(toolCall("apply_patch"), { mode: "git-spice" })).toEqual({
			block: true,
			reason: expect.stringContaining("Could not verify the Git-Spice trunk branch"),
		});
	});
});

describe("Graphite skills", () => {
	test("exposes generic skill names only", () => {
		const skillDir = gitToolResources("graphite").skillPaths?.[0];
		if (!skillDir) throw new Error("missing Graphite skill directory");

		expect(skillDirectoryNames(skillDir)).toEqual(["restack", "stack", "submit", "sync"]);
	});

	test("preserves Graphite submit safety rules", () => {
		const skillDir = gitToolResources("graphite").skillPaths?.[0];
		if (!skillDir) throw new Error("missing Graphite skill directory");

		const submit = readFileSync(`${skillDir}/submit/SKILL.md`, "utf8");

		expect(submit).toContain("name: submit");
		expect(submit).toContain("gt ss -u");
		expect(submit).toContain("Default is `gt ss -u`");
		expect(submit).not.toContain("name: gt-submit");
	});

	test("removes legacy Graphite skill resources", () => {
		expect(existsSync("pi/agent/graphite-skills")).toBe(false);
	});
});

describe("git-tool extension", () => {
	test("registers resource discovery using configured mode", () => {
		const { handlers } = createPi("main");

		expect(handlers.get("resources_discover")?.[0]?.({}, {})).toEqual({});
	});

	test("registers before_agent_start prompt injection for main mode", () => {
		const { handlers } = createPi("main");

		const result = handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, {});

		expect(result).toEqual({ systemPrompt: appendGitToolPrompt("base", "main") });
	});

	test("does not inject prompt for invalid mode", () => {
		const { handlers } = createPi("invalid");

		expect(handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, {})).toBeUndefined();
	});

	test("blocks trunk tool calls through the extension handler", () => {
		const { handlers } = createPi("graphite", "main", "main");

		expect(handlers.get("tool_call")?.[0]?.(toolCall("apply_patch"), {})).toEqual({
			block: true,
			reason: expect.stringContaining("Start a stack branch first"),
		});
	});
});

function skillDirectoryNames(skillDir: string): string[] {
	return readdirSync(skillDir)
		.filter((name) => statSync(`${skillDir}/${name}`).isDirectory())
		.sort();
}
