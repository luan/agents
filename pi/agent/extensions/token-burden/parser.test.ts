import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../system-prompt";
import { parseSystemPrompt } from "./parser";

const skill = {
	name: "tdd",
	description: "Apply test-driven development",
	filePath: "/skills/tdd/SKILL.md",
	baseDir: "/skills/tdd",
	sourceInfo: { path: "/skills/tdd/SKILL.md", source: "test", scope: "project", origin: "top-level" },
	disableModelInvocation: false,
};

describe("token-burden system prompt parser", () => {
	test("detects Skillful-active skill entries without locations", () => {
		const prompt = buildSystemPrompt("base", {
			cwd: "/repo",
			selectedTools: ["skill"],
			skills: [skill],
		});

		const parsed = parseSystemPrompt(prompt);

		expect(parsed.skills).toEqual([
			{
				name: "tdd",
				description: "Apply test-driven development",
				location: "",
				chars: expect.any(Number),
				tokens: expect.any(Number),
			},
		]);
		expect(parsed.sections.some((section) => section.label === "Skills (1)")).toBe(true);
	});

	test("detects read-fallback skill entry locations", () => {
		const prompt = buildSystemPrompt("base", {
			cwd: "/repo",
			selectedTools: ["read"],
			skills: [skill],
		});

		const parsed = parseSystemPrompt(prompt);

		expect(parsed.skills[0]?.location).toBe("/skills/tdd/SKILL.md");
	});
});
