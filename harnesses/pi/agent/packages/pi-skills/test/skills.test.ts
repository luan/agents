import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToLlm, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getCodeModeToolAdapterRegistry } from "pi-code-mode/sdk";
import { icon } from "pi-libtui";
import {
	getDeveloperMessageContributionRegistry,
	renderDeveloperMessages,
} from "../../pi-developer-prompt/src/developer-messages.ts";
import skillsExtension from "../src/extension.ts";
import { registerSkillsPromptContribution, renderSkillsCatalog } from "../src/prompt.ts";
import { createSkillTool } from "../src/tools/skill/definition.ts";

interface SentSkillMessage {
	customType: string;
	content: string;
	display: boolean;
	details: object;
}

function skillTool(filePath: string) {
	const sent: Array<{ message: SentSkillMessage; options: { deliverAs: string } }> = [];
	const tool = createSkillTool({
		getCommands: () => [
			{
				name: "skill:writing-for-agents",
				description: "Writing documents for agents.",
				source: "skill",
				sourceInfo: { path: filePath },
			},
		],
		sendMessage: async (message: SentSkillMessage, options: { deliverAs: string }) => {
			sent.push({ message, options });
		},
	} as never);
	return { tool, sent };
}

test("loads a skill without frontmatter", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-skills-"));
	const filePath = join(directory, "SKILL.md");
	writeFileSync(filePath, "---\nname: writing-for-agents\ndescription: Write.\n---\n# Write\n\nUse short sentences.\n");

	const { tool, sent } = skillTool(filePath);
	const result = await tool.execute("call", { name: "writing-for-agents" }, undefined, undefined, {} as never);

	expect(result.content).toEqual([{ type: "text", text: 'Loaded skill "writing-for-agents".' }]);
	expect(result.details).toMatchObject({
		version: 1,
		tool: "skill",
		status: "loaded",
		requestedName: "writing-for-agents",
		name: "writing-for-agents",
		filePath,
		directory,
		frontmatterRemoved: true,
		hasSupportingFiles: false,
		supportingFiles: [],
	});
	expect(JSON.parse(JSON.stringify(result.details))).toEqual(result.details);
	const rendered = tool.renderResult!(
		result,
		{ expanded: false, isPartial: false },
		{
			name: "skills-test",
			bold: (text: string) => text,
			getColorMode: () => "truecolor",
			getFgAnsi: () => "\x1b[39m",
			getBgAnsi: () => "\x1b[49m",
		} as never,
		{ invalidate() {}, isError: false } as never,
	) as unknown as {
		render(width: number): string[];
		onMouse?(event: {
			type: "move" | "press" | "release";
			row: number;
			col: number;
			screenRow: number;
			screenCol: number;
			button: 0 | 2;
			wheel: undefined;
			shift: false;
			alt: false;
			ctrl: false;
		}): boolean;
	};
	const compact = rendered.render(80).join("\n");
	expect(Bun.stripANSI(compact)).not.toContain("# Write");
	expect(Bun.stripANSI(compact).split("\n")).toHaveLength(1);
	expect(Bun.stripANSI(compact)).toContain("💡 Skill · writing-for-agents · 8 tokens");
	const pointer = {
		row: 0,
		col: 79,
		screenRow: 0,
		screenCol: 79,
		button: 0 as const,
		wheel: undefined,
		shift: false as const,
		alt: false as const,
		ctrl: false as const,
	};
	expect(rendered.onMouse?.({ ...pointer, type: "move" })).toBe(true);
	const hovered = rendered.render(80).join("\n");
	expect(Bun.stripANSI(hovered).trimEnd()).toBe(Bun.stripANSI(compact).trimEnd());
	expect(hovered).not.toBe(compact);
	expect(rendered.onMouse?.({ ...pointer, type: "press" })).toBe(true);
	expect(rendered.onMouse?.({ ...pointer, type: "release" })).toBe(true);
	const expandedSkill = Bun.stripANSI(rendered.render(80).join("\n"));
	expect(expandedSkill).toContain("💡 Skill · writing-for-agents · 8 tokens");
	expect(expandedSkill).toContain("Write");
	expect(expandedSkill).toContain("Use short sentences.");
	expect(expandedSkill).not.toContain("# Write");
	const secondaryPointer = { ...pointer, button: 2 as const };
	expect(rendered.onMouse?.({ ...secondaryPointer, type: "press" })).toBe(true);
	expect(rendered.onMouse?.({ ...secondaryPointer, type: "release" })).toBe(true);
	const foldedSkill = Bun.stripANSI(rendered.render(80).join("\n"));
	expect(foldedSkill.split("\n")).toHaveLength(1);
	expect(rendered.onMouse?.({ ...secondaryPointer, type: "press" })).toBe(true);
	expect(rendered.onMouse?.({ ...secondaryPointer, type: "release" })).toBe(true);
	expect(Bun.stripANSI(rendered.render(80).join("\n"))).toContain("Use short sentences.");
	expect(sent).toMatchObject([
		{
			message: {
				customType: "pi-skills/loaded",
				content: `<skill>\n<name>writing-for-agents</name>\n<path>${filePath}</path>\n# Write\n\nUse short sentences.\n\n</skill>`,
				display: false,
				details: { version: 1, tool: "skill", status: "loaded", name: "writing-for-agents", filePath },
			},
			options: { deliverAs: "steer" },
		},
	]);
	expect(
		convertToLlm([
			{
				role: "custom",
				...sent[0]!.message,
				timestamp: 1,
			},
		] as never),
	).toEqual([
		{
			role: "user",
			content: [{ type: "text", text: sent[0]!.message.content }],
			timestamp: 1,
		},
	]);
});

test("restored pre-instructions skill details stay compact and do not crash", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-skills-"));
	const filePath = join(directory, "SKILL.md");
	writeFileSync(filePath, "# Write\n");
	const { tool } = skillTool(filePath);
	const historical = {
		content: [{ type: "text", text: 'Loaded skill "writing-for-agents".' }],
		details: {
			version: 1,
			tool: "skill",
			status: "loaded",
			name: "writing-for-agents",
			filePath,
			loadedChars: 8,
			supportingFiles: [],
		},
	} as never;
	const component = tool.renderResult!(
		historical,
		{ expanded: false, isPartial: false },
		{
			name: "skills-test",
			bold: (text: string) => text,
			getColorMode: () => "truecolor",
			getFgAnsi: () => "\x1b[39m",
			getBgAnsi: () => "\x1b[49m",
		} as never,
		{ invalidate() {}, isError: false } as never,
	);
	expect(Bun.stripANSI(component.render(80).join("\n")).split("\n")).toHaveLength(1);
});

test("missing skill details render a compact expandable failure", () => {
	const { tool } = skillTool("/missing/SKILL.md");
	const component = tool.renderResult!(
		{ content: [{ type: "text", text: 'Unknown skill "missing"' }], details: undefined as never },
		{ expanded: false, isPartial: false },
		{
			name: "skills-test",
			bold: (text: string) => text,
			getColorMode: () => "truecolor",
			getFgAnsi: () => "\x1b[39m",
			getBgAnsi: () => "\x1b[49m",
		} as never,
		{ args: { name: "missing" }, invalidate() {}, isError: true } as never,
	);
	expect(Bun.stripANSI(component.render(80).join("\n"))).toBe(`${icon("error")} Skill failed · missing ›`);
});

test("omits the directory when agents/openai.yaml is the only companion file", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-skills-"));
	const filePath = join(directory, "SKILL.md");
	mkdirSync(join(directory, "agents"));
	writeFileSync(filePath, "# Write\n");
	writeFileSync(join(directory, "agents", "openai.yaml"), "interface:\n  display_name: Write\n");

	const { tool, sent } = skillTool(filePath);
	const result = await tool.execute("call", { name: "writing-for-agents" }, undefined, undefined, {} as never);

	expect(result.content).toEqual([{ type: "text", text: 'Loaded skill "writing-for-agents".' }]);
	expect(sent[0]?.message.content).not.toContain("Skill directory:");
});

test("appends the absolute directory when the skill has supporting files", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-skills-"));
	const filePath = join(directory, "SKILL.md");
	writeFileSync(filePath, "---\nname: writing-for-agents\n---\n# Write\n");
	writeFileSync(join(directory, "SKILL-MECHANICS.md"), "# Mechanics\n");

	const { tool, sent } = skillTool(filePath);
	const result = await tool.execute("call", { name: "writing-for-agents" }, undefined, undefined, {} as never);

	expect(result.content).toEqual([{ type: "text", text: 'Loaded skill "writing-for-agents".' }]);
	expect(sent[0]?.message.content).toContain(`# Write\n\nSkill directory: ${directory}`);
	expect(result.details).toMatchObject({
		hasSupportingFiles: true,
		supportingFiles: ["SKILL-MECHANICS.md"],
		supportingFilesTruncated: false,
	});
});

test("reports an unknown exact skill name", async () => {
	const tool = createSkillTool({ getCommands: () => [], sendMessage: async () => {} } as never);

	expect(tool.execute("call", { name: "missing" }, undefined, undefined, {} as never)).rejects.toThrow(
		'Unknown skill "missing"',
	);
});

test("publishes visible skill names without filesystem locations", () => {
	const catalog = renderSkillsCatalog([
		{
			name: "writing-for-agents",
			description: "Write agent instructions.",
			filePath: "/private/skills/writing-for-agents/SKILL.md",
			disableModelInvocation: false,
		},
		{
			name: "hidden",
			description: "Hidden skill.",
			filePath: "/private/skills/hidden/SKILL.md",
			disableModelInvocation: true,
		},
	] as never);

	expect(catalog).toContain("writing-for-agents: Write agent instructions.");
	expect(catalog).not.toContain("/private/skills");
	expect(catalog).not.toContain("hidden");
});

test("adds the skill catalogue when skill is direct or available through exec", () => {
	getDeveloperMessageContributionRegistry().clear();
	const dispose = registerSkillsPromptContribution();
	try {
		const messages = renderDeveloperMessages({
			provider: "openai-codex",
			activeTools: ["skill"],
			sessionId: "session-1",
			systemPromptOptions: {
				cwd: "/repo",
				skills: [
					{
						name: "writing-for-agents",
						description: "Write agent instructions.",
						filePath: "/skills/writing-for-agents/SKILL.md",
						disableModelInvocation: false,
					},
				] as never,
			},
		});

		expect(messages).toEqual([
			{
				id: "pi-skills/catalog",
				content: expect.stringContaining("Call `tools.skill`"),
			},
		]);
		expect(
			renderDeveloperMessages({
				provider: "openai-codex",
				activeTools: ["exec"],
				sessionId: "session-1",
				systemPromptOptions: {
					cwd: "/repo",
					skills: [{ name: "writing-for-agents", description: "Write agent instructions." }] as never,
				},
			}),
		).toHaveLength(1);
	} finally {
		dispose();
		getDeveloperMessageContributionRegistry().clear();
	}
});

test("registers the skill execution bridge with Code Mode", () => {
	const adapters = getCodeModeToolAdapterRegistry().adapters;
	const previous = adapters.get("skill");
	adapters.delete("skill");
	try {
		const tools: ToolDefinition[] = [];
		const handlers = new Map<string, (event: { reason: string }) => void>();
		const messageRenderers = new Map<string, () => { render(width: number): string[] }>();
		skillsExtension({
			registerTool(tool: ToolDefinition) {
				tools.push(tool);
			},
			on(event: string, handler: (event: { reason: string }) => void) {
				handlers.set(event, handler);
			},
			registerMessageRenderer(type: string, renderer: () => { render(width: number): string[] }) {
				messageRenderers.set(type, renderer);
			},
			getCommands: () => [],
			sendMessage: async () => {},
		} as never);
		expect(tools).toHaveLength(1);
		expect(messageRenderers.get("pi-skills/loaded")?.().render(80)).toEqual([]);
		expect(adapters.get("skill")).toMatchObject({ name: "skill", kind: "function" });
		expect(adapters.get("skill")).not.toHaveProperty("exposure");
		handlers.get("session_shutdown")?.({ reason: "new" });
		expect(adapters.get("skill")).toBeDefined();
		handlers.get("session_shutdown")?.({ reason: "reload" });
		expect(adapters.get("skill")).toBeUndefined();
	} finally {
		if (previous === undefined) adapters.delete("skill");
		else adapters.set("skill", previous);
	}
});

test("does not add skill guidance when the skill tool is inactive", () => {
	getDeveloperMessageContributionRegistry().clear();
	const dispose = registerSkillsPromptContribution();
	try {
		const context = {
			provider: "openai-codex",
			sessionId: "session-1",
			systemPromptOptions: {
				cwd: "/repo",
				skills: [
					{
						name: "writing-for-agents",
						description: "Write agent instructions.",
						filePath: "/skills/writing-for-agents/SKILL.md",
						disableModelInvocation: false,
					},
				] as never,
			},
		};

		expect(renderDeveloperMessages({ ...context, activeTools: [] })).toEqual([]);
		expect(renderDeveloperMessages({ ...context, activeTools: ["read"] })).toEqual([]);
	} finally {
		dispose();
		getDeveloperMessageContributionRegistry().clear();
	}
});

test("catalogue visibility supports always and off without changing skill discovery", () => {
	getDeveloperMessageContributionRegistry().clear();
	let catalogVisibility: "always" | "off" = "always";
	const dispose = registerSkillsPromptContribution(() => ({
		catalogVisibility,
	}));
	const context = {
		provider: "openai-codex",
		activeTools: [] as string[],
		sessionId: "session-1",
		systemPromptOptions: {
			cwd: "/repo",
			skills: [{ name: "writing-for-agents", description: "Write agent instructions." }] as never,
		},
	};
	try {
		expect(renderDeveloperMessages(context)).toHaveLength(1);
		catalogVisibility = "off";
		expect(renderDeveloperMessages(context)).toEqual([]);
	} finally {
		dispose();
		getDeveloperMessageContributionRegistry().clear();
	}
});

test("hidden loaded-skill display still sends identical model context", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-skills-"));
	const filePath = join(directory, "SKILL.md");
	writeFileSync(filePath, "# Write\n");
	const sent: SentSkillMessage[] = [];
	const tool = createSkillTool({
		getCommands: () => [
			{
				name: "skill:writing-for-agents",
				description: "Writing documents for agents.",
				source: "skill",
				sourceInfo: { path: filePath },
			},
		],
		sendMessage: async (message: SentSkillMessage) => {
			sent.push(message);
		},
	} as never);

	await tool.execute("call", { name: "writing-for-agents" }, undefined, undefined, {} as never);
	expect(sent[0].display).toBe(false);
	expect(convertToLlm([{ role: "custom", ...sent[0], timestamp: 1 }] as never)).toEqual([
		{
			role: "user",
			content: [{ type: "text", text: sent[0].content }],
			timestamp: 1,
		},
	]);
});
