import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../system-prompt";
import { parseSystemPrompt } from "./parser";

describe("token-burden system prompt parser", () => {
	test("detects structured environment context as metadata footer", () => {
		const prompt = buildSystemPrompt("base", {
			cwd: "/repo",
			selectedTools: [],
			environmentContext: {
				shell: "zsh",
				timezone: "Etc/UTC",
			},
			now: new Date(2026, 4, 10),
		});

		const parsed = parseSystemPrompt(prompt);
		const metadata = parsed.sections.find((section) => section.label === "Metadata (environment context)");

		expect(metadata?.content).toStartWith("<environment_context>");
		expect(metadata?.content).toContain("<cwd>/repo</cwd>");
		expect(metadata?.content).toContain("<shell>zsh</shell>");
	});

	test("parses YAML skill entries", () => {
		const prompt = [
			"base",
			"<skills_instructions>",
			"The following skills provide specialized instructions",
			"<available_skills>",
			"- fast: Apply test-driven development (quick mode)",
			"- local: Load a local skill (/skills/local/SKILL.md)",
			"</available_skills>",
			"</skills_instructions>",
			"",
			"Current date: 2026-05-10",
		].join("\n");

		const parsed = parseSystemPrompt(prompt);

		expect(parsed.skills.map(({ name }) => name)).toEqual(["fast", "local"]);
		expect(parsed.skills.every(({ chars, tokens }) => chars > 0 && tokens > 0)).toBe(true);
	});
});
