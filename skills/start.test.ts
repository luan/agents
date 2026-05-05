import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const startSkill = () => readFileSync("skills/start/SKILL.md", "utf8");

describe("start skill git-tool strategy", () => {
	test("uses agents.git-tool instead of detecting loaded plugins or branch state", () => {
		const body = startSkill();

		expect(body).toContain("agents.git-tool");
		expect(body).not.toContain("detect stack tool");
		expect(body).not.toContain("gt plugin loaded");
	});

	test("documents configured branch creation commands", () => {
		const body = startSkill();

		expect(body).toContain("gt create <branch-name>");
		expect(body).toContain("gs branch create <branch-name>");
		expect(body).toContain("gs bc <branch-name>");
	});

	test("keeps trunk edit gating in the git-tool extension", () => {
		const body = startSkill();

		expect(body).toContain("does not decide whether editing is allowed");
		expect(body).toContain("git-tool extension");
	});
});
