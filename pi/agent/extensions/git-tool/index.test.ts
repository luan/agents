import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { basename } from "node:path";
import gitToolExtension, {
	appendGitToolPrompt,
	GIT_TOOL_GH_STACK_PROMPT_ADDENDUM,
	GIT_TOOL_GIT_SPICE_PROMPT_ADDENDUM,
	GIT_TOOL_GRAPHITE_PROMPT_ADDENDUM,
	GIT_TOOL_MAIN_PROMPT_ADDENDUM,
	gitToolResources,
	gitToolToolCallBlock,
	parseGitToolMode,
} from "./index";

type Handler = (...args: any[]) => unknown;

/** Modes that ship a skill directory, as opposed to main/none which ship none. */
const STACKED_MODES = ["graphite", "git-spice", "gh-stack"] as const;

const PROMPT_ADDENDA = [
	["graphite", GIT_TOOL_GRAPHITE_PROMPT_ADDENDUM],
	["git-spice", GIT_TOOL_GIT_SPICE_PROMPT_ADDENDUM],
	["gh-stack", GIT_TOOL_GH_STACK_PROMPT_ADDENDUM],
	["main", GIT_TOOL_MAIN_PROMPT_ADDENDUM],
] as const;

function createPi(configValue: string | undefined) {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};

	gitToolExtension(pi as any, {
		readGitToolConfig: () => configValue,
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
		["gh-stack", "gh-stack"],
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
	test.each(STACKED_MODES)("%s contributes exactly its own skill directory", (mode) => {
		const resources = gitToolResources(mode);

		expect(resources.skillPaths?.map((path) => basename(path))).toEqual([mode]);
		expect(resources.skillPaths?.[0]?.replace(/\\/g, "/")).toContain(`git-tool/skill-resources/${mode}`);
	});

	test.each(STACKED_MODES)("%s exposes generic skill names only", (mode) => {
		const skillDir = gitToolResources(mode).skillPaths?.[0];
		if (!skillDir) throw new Error(`missing ${mode} skill directory`);

		expect(skillDirectoryNames(skillDir)).toEqual(["restack", "stack", "submit", "sync"]);
	});

	test.each(["main", "none"] as const)("%s contributes no skill paths", (mode) => {
		expect(gitToolResources(mode)).toEqual({});
	});
});

describe("git-tool prompt addendum", () => {
	test.each(PROMPT_ADDENDA)("%s appends its addendum without dropping the base prompt", (mode, addendum) => {
		const prompt = appendGitToolPrompt("base", mode);

		expect(prompt.startsWith("base")).toBe(true);
		expect(prompt).toContain(addendum);
	});

	test.each(PROMPT_ADDENDA)("%s addendum is idempotent", (mode) => {
		const once = appendGitToolPrompt("base", mode);
		expect(appendGitToolPrompt(once, mode)).toBe(once);
	});

	test("none mode leaves system prompt unchanged", () => {
		expect(appendGitToolPrompt("base", "none")).toBe("base");
	});
});

describe("git-tool tool-call handling", () => {
	test.each([
		"apply_patch",
		"functions.apply_patch",
		"edit",
		"write",
		"exec_command",
		"bash",
		"functions.exec_command",
	])("allows %s", (toolName) => {
		expect(gitToolToolCallBlock(toolCall(toolName))).toBeUndefined();
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

	test("allows tool calls through the extension handler", () => {
		const { handlers } = createPi("graphite");

		expect(handlers.get("tool_call")?.[0]?.(toolCall("apply_patch"), {})).toBeUndefined();
	});
});

function skillDirectoryNames(skillDir: string): string[] {
	return readdirSync(skillDir)
		.filter((name) => statSync(`${skillDir}/${name}`).isDirectory())
		.sort();
}
