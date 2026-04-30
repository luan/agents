import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const policy = readFileSync(new URL("../team-mode/policy.ts", import.meta.url), "utf8");

test("Pi exposes source navigation tools from the source extension", () => {
	for (const tool of [
		"source_search",
		"source_show",
		"source_outline",
		"source_refs",
		"source_impact",
		"source_trace",
		"source_impls",
		"source_investigate",
		"source_diff",
	]) {
		expect(source).toContain(`name: "${tool}"`);
		expect(policy).toContain(`"${tool}"`);
	}
	expect(source).toContain('"source", subcommand, "--json"');
});

test("Pi does not keep backend source helper extensions", () => {
	for (const dir of ["../sym/index.ts", "../ast/index.ts", "../lsp/index.ts"]) {
		expect(existsSync(new URL(dir, import.meta.url))).toBe(false);
	}
	for (const tool of [
		"sym_search",
		"sym_show",
		"sym_outline",
		"sym_refs",
		"sym_impact",
		"sym_trace",
		"sym_impls",
		"sym_investigate",
		"sym_diff",
		"sym_context",
		"sym_structure",
		"ast_grep_search",
		"ast_grep_replace",
		"lsp_navigation",
		"lsp_diagnostics",
	]) {
		expect(source).not.toContain(`name: "${tool}"`);
		expect(policy).not.toContain(`"${tool}"`);
	}
	expect(existsSync(new URL("../source-surface.test.ts", import.meta.url))).toBe(false);
});
