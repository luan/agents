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
			expect(body).toContain("Do not pass vault stems");
			expect(body).toContain("exact absolute file");
			expect(body).toContain("plannotator");
		});
	}

	test("plan keeps artifact content paths separate from Plannotator target paths", () => {
		const body = skill("plan");

		expect(body).toContain("Use repo-relative paths only inside artifact content");
		expect(body).toContain("Plannotator still needs the real absolute local file path");
	});
});
describe("pr-descr skill", () => {
	test("keeps testing sections focused on manual verification", () => {
		const body = skill("pr-descr");

		expect(body).toContain("Do not list the tests, checks, or commands the agent ran");
		expect(body).toContain("Do not use the phrase \"automated testing\"");
		expect(body).toContain("Use \"Manual testing not reported\" when there is no manual evidence");
		expect(body).not.toContain("`Ran:` exact command names");
		expect(body).not.toContain("unless the template explicitly asks for automated checks");
	});

	test("preserves template headings instead of adding generic change inventories", () => {
		const body = skill("pr-descr");

		expect(body).toContain("preserve its top-level headings");
		expect(body).toContain("Do not create a \"what changed\" inventory or add a \"Changes\" section");
	});
});

describe("flattened workflow skills", () => {
	test("provides grill, brief, and issues as bundled default workflow skills", () => {
		expect(skill("grill")).toContain("name: grill");
		expect(skill("brief")).toContain("name: brief");
		expect(skill("issues")).toContain("name: issues");
	});

	test("grill is grounded interview only with no side effects", () => {
		const body = skill("grill");

		expect(body).toContain("Do not edit files");
		expect(body).toContain("No task creation");
		expect(body).toContain("Grill Summary");
	});

	test("brief requires approved durable vault publication before follow-on work", () => {
		const body = skill("brief");

		expect(body).toContain("durable vault artifact");
		expect(body).toContain("plannotator annotate");
		expect(body).toContain("Do not commit and do not create tasks");
	});

	test("issues uses structured task bodies and creates tasks only after approval", () => {
		const body = skill("issues");

		expect(body).toContain("Task records are\ncreated only after the issue proposal is approved");
		expect(body).toContain("Agent-verifiable acceptance criteria");
		expect(body).toContain("Human-judgment acceptance criteria");
		expect(body).toContain("Delivery evidence placeholder");
	});
});
