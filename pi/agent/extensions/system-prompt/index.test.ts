import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./index";

const baseOptions = {
	cwd: "/repo",
	skills: [
		{
			name: "tdd",
			description: "Apply test-driven development",
			filePath: "/skills/tdd/SKILL.md",
			baseDir: "/skills/tdd",
			sourceInfo: { path: "/skills/tdd/SKILL.md", source: "test", scope: "project", origin: "top-level" },
			disableModelInvocation: false,
		},
	],
};

describe("system-prompt Skillful skill rendering", () => {
	test("skill tool active lists skills by name and description only", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: ["skill"],
		});

		expect(prompt).toContain("The following skills provide specialized instructions");
		expect(prompt).toContain("call `skill({name})`");
		expect(prompt).toContain('matching `<skill name="...">` block is already in context');
		expect(prompt).toContain("- tdd: Apply test-driven development");
		expect(prompt).not.toContain("/skills/tdd/SKILL.md");
	});

	test("read fallback keeps skill locations", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: ["read"],
		});

		expect(prompt).toContain("read the referenced `SKILL.md` file");
		expect(prompt).toContain("- tdd: Apply test-driven development (/skills/tdd/SKILL.md)");
	});

	test("omits skills when no loading tool is active", () => {
		const prompt = buildSystemPrompt("base", {
			...baseOptions,
			selectedTools: [],
		});

		expect(prompt).not.toContain("<available_skills>");
		expect(prompt).not.toContain("- tdd: Apply test-driven development");
	});
});
