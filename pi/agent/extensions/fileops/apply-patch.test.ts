import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runApplyPatch } from "./apply-patch.ts";
import { normalizeApplyPatchInput } from "./execution.ts";

it("normalizes file URIs before invoking the native engine", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-apply-patch-uri-"));
	const path = join(cwd, "sample.txt");
	const uri = pathToFileURL(path).href;
	const input = `*** Begin Patch\n*** Update File: ${uri}\n@@\n-old\n+new\n*** End Patch\n`;

	expect(normalizeApplyPatchInput(cwd, input)).toContain(`*** Update File: ${path}`);
});

it("canonicalizes FILE headers case-insensitively", () => {
	const input = "*** Begin Patch\n*** UPDATE FILE: sample.txt\n@@\n-old\n+new\n*** End Patch\n";

	expect(normalizeApplyPatchInput(process.cwd(), input)).toContain("*** Update File: sample.txt");
});
it("runs the copied apply_patch engine", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-apply-patch-adapter-"));
	writeFileSync(join(cwd, "sample.txt"), "hello\nworld\n");

	const result = await runApplyPatch(
		cwd,
		"*** Begin Patch\n*** Update File: sample.txt\n@@\n-hello\n+hi\n world\n*** End Patch\n",
	);

	expect(result.status).toBe("success");
	expect(result.result.changedFiles).toEqual(["sample.txt"]);
	expect(readFileSync(join(cwd, "sample.txt"), "utf8")).toBe("hi\nworld\n");
});
