import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	extractNotebookNpmImports,
	formatNotebookNpmImportsNotice,
	readNotebookNpmImports,
	recordNotebookNpmImports,
	resetNotebookNpmImports,
} from "./npm-imports.ts";

function identity(): { project: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-notebook-npm-"));
	return { project: join(root, "project"), agentDir: join(root, "agent") };
}

function manifestPath(project: string, agentDir: string): string {
	const key = createHash("sha256").update(resolve(project)).digest("hex").slice(0, 32);
	const directory = join(agentDir, "notebook", "npm-imports");
	mkdirSync(directory, { recursive: true });
	return join(directory, `${key}.json`);
}

it("extracts only exact-version static import specifiers", () => {
	expect(
		extractNotebookNpmImports(`
			import ky from "npm:ky@1.7.2";
			const { default: chalk } = await import("npm:chalk@5.3.0");
			export { z } from 'npm:zod@3.23.8';
			import scoped from "npm:@scope/pkg@2.0.0-rc.1/sub";
		`),
	).toEqual(["npm:@scope/pkg@2.0.0-rc.1/sub", "npm:chalk@5.3.0", "npm:ky@1.7.2", "npm:zod@3.23.8"]);
});

it("rejects a specifier without an exact version", () => {
	expect(
		extractNotebookNpmImports(`
			import a from "npm:ky";
			import b from "npm:ky@^1.7.2";
			import c from "npm:ky@latest";
			import d from "npm:ky@1.7";
		`),
	).toEqual([]);
});

it("never inventories a specifier that only appears in a comment, a string, or a regex", () => {
	// An inventoried package skips approval forever, so a phantom entry is a bypass.
	const source = `
		// import evil from "npm:evil@1.0.0";
		/* import worse from "npm:worse@1.0.0"; */
		const note = "import fake from \\"npm:fake@1.0.0\\"";
		const pattern = /import from "npm:regex@1.0.0"/;
		const dynamic = "npm:dynamic@1.0.0";
		await import(dynamic);
		import real from "npm:real@1.0.0";
	`;
	expect(extractNotebookNpmImports(source)).toEqual(["npm:real@1.0.0"]);
});

it("does not inventory a template specifier with a substitution", () => {
	expect(extractNotebookNpmImports(`const v = '1.0.0'; await import(\`npm:pkg@\${v}\`);`)).toEqual([]);
});

it("records, merges, sorts, and resets the inventory", () => {
	const id = identity();
	expect(readNotebookNpmImports(id)).toEqual([]);
	expect(recordNotebookNpmImports(id, ["npm:zod@3.23.8"])).toEqual(["npm:zod@3.23.8"]);
	expect(recordNotebookNpmImports(id, ["npm:ky@1.7.2", "npm:zod@3.23.8"])).toEqual(["npm:ky@1.7.2", "npm:zod@3.23.8"]);
	expect(readNotebookNpmImports(id)).toEqual(["npm:ky@1.7.2", "npm:zod@3.23.8"]);
	resetNotebookNpmImports(id);
	expect(readNotebookNpmImports(id)).toEqual([]);
});

it("rejects an inexact specifier before it reaches the file", () => {
	const id = identity();
	expect(() => recordNotebookNpmImports(id, ["npm:ky@^1.7.2"])).toThrow("inexact specifier");
	expect(readNotebookNpmImports(id)).toEqual([]);
});

it("rejects a manifest with the wrong schema, project, or specifier shape", () => {
	for (const manifest of [
		{ schema: 2, project: "", imports: ["npm:ky@1.7.2"] },
		{ schema: 1, project: "/somewhere/else", imports: ["npm:ky@1.7.2"] },
		{ schema: 1, project: "", imports: ["npm:ky@latest"] },
		{ schema: 1, project: "", imports: "npm:ky@1.7.2" },
		{ schema: 1, project: "", imports: [42] },
		{ project: "", imports: [] },
	]) {
		const id = identity();
		const path = manifestPath(id.project, id.agentDir);
		const project = manifest.project === "" ? resolve(id.project) : manifest.project;
		writeFileSync(path, JSON.stringify({ ...manifest, project }));
		expect(readNotebookNpmImports(id)).toEqual([]);
	}
});

it("rejects unparseable and symlinked manifests", () => {
	const broken = identity();
	writeFileSync(manifestPath(broken.project, broken.agentDir), "{ not json");
	expect(readNotebookNpmImports(broken)).toEqual([]);

	const linked = identity();
	const target = join(mkdtempSync(join(tmpdir(), "pi-notebook-npm-target-")), "inventory.json");
	writeFileSync(target, JSON.stringify({ schema: 1, project: resolve(linked.project), imports: ["npm:ky@1.7.2"] }));
	symlinkSync(target, manifestPath(linked.project, linked.agentDir));
	expect(readNotebookNpmImports(linked)).toEqual([]);
});

it("keeps two projects under one agent directory separate", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-notebook-npm-split-"));
	const agentDir = join(root, "agent");
	const one = { project: join(root, "one"), agentDir };
	const two = { project: join(root, "two"), agentDir };
	recordNotebookNpmImports(one, ["npm:ky@1.7.2"]);
	expect(readNotebookNpmImports(two)).toEqual([]);
	expect(readNotebookNpmImports(one)).toEqual(["npm:ky@1.7.2"]);
});

it("states the approval rule in the startup notice", () => {
	expect(formatNotebookNpmImportsNotice([])).toContain("none");
	const notice = formatNotebookNpmImportsNotice(["npm:ky@1.7.2"]);
	expect(notice).toContain("npm:ky@1.7.2");
	expect(notice).toContain("ask the user before first use of any unlisted package");
});
