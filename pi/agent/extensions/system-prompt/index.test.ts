import { expect, test } from "bun:test";
import { registerTool, resetToolRegistry } from "../shared/tool-registry.ts";
import { buildSystemPrompt } from "./index.ts";

const noopApi = { registerTool() {} } as never;

const SKILL = { name: "tdd", description: "Test-driven development", path: "/skills/tdd/SKILL.md" };

/**
 * Under code-mode the active set is `exec`, `wait`, `ask_user`, and everything
 * else is reached from inside a cell. The template gates its largest section —
 * the whole skills catalogue — on `read`, so gating on the active set drops
 * every skill from the prompt and reports nothing: the model simply stops
 * knowing that skills exist, and the only symptom is worse answers.
 */
test("keeps the read-gated sections when read is nested rather than direct", () => {
	resetToolRegistry();
	registerTool(noopApi, { name: "read", execute: () => undefined });

	const prompt = buildSystemPrompt("base", {
		cwd: "/repo",
		selectedTools: ["exec", "wait", "ask_user"],
		skills: [SKILL] as never,
	});

	expect(prompt).toContain("<skills_instructions>");
	expect(prompt).toContain("tdd");
	resetToolRegistry();
});

test("drops them when read is registered nowhere", () => {
	resetToolRegistry();

	const prompt = buildSystemPrompt("base", {
		cwd: "/repo",
		selectedTools: ["exec", "wait", "ask_user"],
		skills: [SKILL] as never,
	});

	expect(prompt).not.toContain("<skills_instructions>");
});
