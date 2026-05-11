import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const skill = (name: string) => readFileSync(`skills/${name}/SKILL.md`, "utf8");
const startSkill = () => skill("start");

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

describe("Plannotator-gated skills", () => {
	const gatedSkills = ["research", "plan", "design", "structure", "implement"] as const;

	for (const name of gatedSkills) {
		test(`${name} requires absolute gate target paths`, () => {
			const body = skill(name);

			expect(body).toContain("absolute");
			expect(body).toContain("targetPath");
			expect(body).toContain("Do not pass vault stems");
			expect(body).toContain("exact absolute file");
		});
	}

	test("plan keeps artifact content paths separate from Plannotator target paths", () => {
		const body = skill("plan");

		expect(body).toContain("Use repo-relative paths only inside artifact content");
		expect(body).toContain("This does not apply to `vault_review.targetPath`");
	});
});
