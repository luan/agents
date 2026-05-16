import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentCwd } from "./cwd";

describe("resolveAgentCwd", () => {
	test("resolves relative cwd from the parent cwd", () => {
		const root = mkdtempSync(join(tmpdir(), "mosaic-cwd-"));
		const nested = join(root, "repo");
		mkdirSync(nested);

		expect(resolveAgentCwd("repo", root)).toBe(nested);
	});

	test("accepts absolute cwd", () => {
		const root = mkdtempSync(join(tmpdir(), "mosaic-cwd-"));
		expect(resolveAgentCwd(root, "/irrelevant")).toBe(root);
	});

	test("rejects files and missing directories", () => {
		const root = mkdtempSync(join(tmpdir(), "mosaic-cwd-"));
		const file = join(root, "file.txt");
		writeFileSync(file, "not a dir");

		expect(() => resolveAgentCwd(file, root)).toThrow("not a directory");
		expect(() => resolveAgentCwd("missing", root)).toThrow("not a directory");
	});
});
