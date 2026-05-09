import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const skill = (name: string) => readFileSync(`skills/${name}/SKILL.md`, "utf8");

describe("research plan implement workflows", () => {
	test("provides first-class workflow skills", () => {
		expect(skill("research")).toContain("name: research");
		expect(skill("plan")).toContain("name: plan");
		expect(skill("implement")).toContain("name: implement");
	});

	test("skills point to the current workflow concepts", () => {
		expect(skill("research")).toContain("use `$plan` after research is approved");
		expect(skill("plan")).toContain("Turn approved research into an implementation plan and executable tasks");
		expect(skill("implement")).toContain("Make one selected task true");
	});

	test("research requires a Plannotator gate before vault commit even with auto", () => {
		const body = skill("research");
		expect(body).toContain('vault_review(op="gate")');
		expect(body).toContain("the Plannotator gate is still required");
		expect(body).toContain("do not set a short timeout for research gates");
		expect(body).toContain("Never commit before the research gate");
		expect(body.indexOf('vault_review(op="gate")')).toBeLessThan(body.indexOf('vault_write(op="commit")'));
	});

	test("research does not ask for approval after Plannotator approval", () => {
		const body = skill("research");
		expect(body).toContain("targeted clarification questions");
		expect(body).toContain("do not frame these as approval");
		expect(body).toContain("A handled approved Plannotator gate is sufficient approval to continue");
		expect(body).toContain("do not ask the user for another approval afterward");
	});

	test("research treats Plannotator transport failure separately from review denial", () => {
		const body = skill("research");
		expect(body).toContain("treat it as content feedback");
		expect(body).toContain("treat it as a Plannotator/tool failure");
		expect(body).toContain("Ask whether to retry the Plannotator gate or pause");
		expect(body).toContain("do not ask the user to approve the research conversationally");
		expect(body).toContain('Keep `vault_write(op="commit")` blocked until a handled approved tool result exists');
		expect(body).toContain("Do not try to recover Plannotator feedback through separate artifact comment extraction");
		expect(body).toContain("Plannotator annotations must arrive through the gate result");
	});

	test("research uses visual review aids without extra approval churn", () => {
		const body = skill("research");
		expect(body).toContain("add a lightweight visual section for Plannotator review");
		expect(body).toContain("Mermaid for flows/sequences/state");
		expect(body).toContain("Graphviz for architecture/dependency maps");
		expect(body).toContain("local SVG/PNG image references");
		expect(body).toContain("ask at most one compact batch");
		expect(body).toContain("Prefer a concrete default recommendation plus a small choice set");
	});

	test("workflow skills do not use vault comments as a feedback channel", () => {
		expect(skill("research")).not.toContain("inline comments");
		expect(skill("plan")).not.toContain("inline comments");
		expect(skill("vault")).not.toContain(["ct vault", "comments"].join(" "));
	});

	test("plan gates temporary task proposals before task creation unless auto", () => {
		const body = skill("plan");
		expect(body).toContain("Draft the plan artifact");
		expect(body).toContain("Draft tasks");
		expect(body).toContain("Do not create tasks until the proposal is approved");
		expect(body).toContain('vault_review(op="gate")');
		expect(body.indexOf('vault_review(op="gate")')).toBeLessThan(body.indexOf("Publish"));
	});

	test("plan requires real artifacts, visual structure, and vertical task slices", () => {
		const body = skill("plan");
		expect(body).toContain("Include the actual plan");
		expect(body).toContain("file/module references");
		expect(body).toContain("Add a compact structural visual");
		expect(body).toContain("source research and plan artifact paths");
		expect(body).toContain("Avoid tiny file-by-file microtasks and broad phase buckets");
		expect(body).toContain("Add a final HITL/review-gated task");
		expect(body).toContain("Use repo-relative paths only");
	});

	test("implement preserves TDD first and skips optional review gates with auto", () => {
		const body = skill("implement");
		expect(body).toContain("TDD loop");
		expect(body).toContain("Run it and confirm it fails for the expected reason");
		expect(body).toContain('vault_review(op="gate", gateType="tests")');
		expect(body).toContain('vault_review(op="code", diffType="uncommitted")');
		expect(body.indexOf("TDD loop")).toBeLessThan(body.indexOf("Optional review gates"));
	});
});
