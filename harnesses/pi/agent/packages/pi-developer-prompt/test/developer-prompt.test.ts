import { afterEach, expect, test } from "bun:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
	composeDeveloperMessages,
	getDeveloperMessageContributionRegistry,
	registerDeveloperMessageContribution,
	renderDeveloperMessages,
} from "../src/developer-messages.ts";
import { buildProviderInstructions } from "../src/provider-instructions.ts";

const context = {
	provider: "chosen",
	activeTools: ["read"],
	sessionId: "session-1",
	prompt: "Current request.",
	systemPromptOptions: { cwd: "/repo" },
};

afterEach(() => getDeveloperMessageContributionRegistry().clear());

test("keeps SYSTEM.md and append-system text in provider instructions", () => {
	expect(
		buildProviderInstructions({
			cwd: "/repo",
			customPrompt: "Owned prompt.",
			appendSystemPrompt: "Additional instructions.",
		}),
	).toBe("Owned prompt.\n\nAdditional instructions.");
});

test("keeps Pi's prompt when SYSTEM.md is absent", () => {
	expect(
		buildProviderInstructions(
			{
				cwd: "/repo",
				appendSystemPrompt: "Already in the Pi prompt.",
			},
			"Pi fallback.\n\nAlready in the Pi prompt.",
		),
	).toBe("Pi fallback.\n\nAlready in the Pi prompt.");
});

test("keeps tool guidance out of separate developer messages", () => {
	registerDeveloperMessageContribution({ id: "mode", content: "Developer mode." });
	const messages = composeDeveloperMessages(
		{
			...context,
			systemPromptOptions: {
				cwd: "/repo",
				promptGuidelines: ["Inspect before editing.", "Inspect before editing.", ""],
			},
		},
		"C:\\repo",
		{
			currentDate: "2026-08-18",
			timezone: "America/Los_Angeles",
			shell: "zsh",
		},
	);

	expect(messages).toEqual([
		{ id: "mode", content: "Developer mode." },
		{
			id: "environment",
			content: [
				"<environment_context>",
				"  <cwd>C:/repo</cwd>",
				"  <shell>zsh</shell>",
				"  <current_date>2026-08-18</current_date>",
				"  <timezone>America/Los_Angeles</timezone>",
				"</environment_context>",
			].join("\n"),
		},
	]);
});

test("reports exec_command's compatible shell instead of Fish", () => {
	const messages = composeDeveloperMessages({ ...context, activeTools: ["exec_command"] }, "/repo", {
		currentDate: "2026-08-26",
		timezone: "America/Los_Angeles",
		shell: "/opt/homebrew/bin/fish",
	});

	const environment = messages.find((message) => message.id === "environment")?.content;
	const expectedShell = process.platform === "darwin" ? "zsh" : process.platform === "win32" ? "bash.exe" : "bash";
	expect(environment).toContain(`<shell>${expectedShell}</shell>`);
	expect(environment).not.toContain("<shell>fish</shell>");
});

test("renders gated extension contributions in stable order", () => {
	registerDeveloperMessageContribution({ id: "z-last", priority: 20, content: "LAST" });
	registerDeveloperMessageContribution({
		id: "a-first",
		priority: 10,
		content: ({ sessionId }) => `FIRST ${sessionId}`,
	});
	registerDeveloperMessageContribution({ id: "wrong-provider", content: "WRONG", providers: ["other"] });
	registerDeveloperMessageContribution({ id: "missing-tool", content: "MISSING", activeTools: ["write"] });

	expect(renderDeveloperMessages(context)).toEqual([
		{ id: "a-first", content: "FIRST session-1" },
		{ id: "z-last", content: "LAST" },
	]);
});

test("passes the current prompt to conditional contributions", () => {
	registerDeveloperMessageContribution({
		id: "conditional",
		content: ({ prompt }) => (prompt === "Annotated request." ? "Annotation guidance." : undefined),
	});

	expect(renderDeveloperMessages({ ...context, prompt: "Ordinary request." })).toEqual([]);
	expect(renderDeveloperMessages({ ...context, prompt: "Annotated request." })).toEqual([
		{ id: "conditional", content: "Annotation guidance." },
	]);
});

test("does not own the skill catalogue", () => {
	const skill = {
		name: "review",
		description: "Review code.",
		filePath: "/skills/review/SKILL.md",
		disableModelInvocation: false,
	} as Skill;

	expect(
		renderDeveloperMessages({
			...context,
			activeTools: ["read", "skill"],
			systemPromptOptions: { cwd: "/repo", skills: [skill] },
		}),
	).toEqual([]);
});
