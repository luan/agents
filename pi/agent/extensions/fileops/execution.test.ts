import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApplyPatchResult } from "./apply-patch.ts";
import {
	applyPatchChangeDiff,
	applyPatchCommittedMessages,
	applyPatchResultText,
	type EditConfig,
	editPreviewForInput,
} from "./execution.ts";

describe("edit preview execution", () => {
	it("returns structured replace preview state without changing the file", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-preview-"));
		const path = join(cwd, "sample.txt");
		writeFileSync(path, "before\nafter\n");
		const config: EditConfig = {
			mode: "replace",
			fuzzyMatch: true,
			fuzzyThreshold: 0.95,
			allowReplaceAll: true,
			autoDropPureInsertDuplicates: false,
		};
		const state: Record<string, unknown> = {};
		const preview = editPreviewForInput(
			"*** File: sample.txt\n*** Old\n|before\n*** New\n|updated",
			config,
			cwd,
			state,
			true,
		);

		expect(preview?.diff).toContain("-before");
		expect(preview?.diff).toContain("+updated");
		expect(state.editPreview).toBeDefined();
		expect(readFileSync(path, "utf8")).toBe("before\nafter\n");
	});
});

describe("apply_patch preview execution", () => {
	it("renders against a disposable filesystem without changing the source", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-apply-preview-"));
		const path = join(cwd, "sample.txt");
		writeFileSync(path, "before\n");
		const config: EditConfig = {
			mode: "apply_patch",
			fuzzyMatch: true,
			fuzzyThreshold: 0.95,
			allowReplaceAll: true,
			autoDropPureInsertDuplicates: false,
		};
		const preview = editPreviewForInput(
			"*** Begin Patch\n*** Update File: sample.txt\n@@\n-before\n+after\n*** End Patch\n",
			config,
			cwd,
			{},
			true,
		);

		expect(preview?.diff).toContain("-before");
		expect(preview?.diff).toContain("+after");
		expect(readFileSync(path, "utf8")).toBe("before\n");
	});
});

describe("apply_patch result rendering", () => {
	const result = (overrides: Partial<ApplyPatchResult> = {}): ApplyPatchResult => ({
		status: "failure",
		error: "second write failed",
		exact: true,
		result: {
			changedFiles: ["removed.txt"],
			createdFiles: [],
			deletedFiles: ["removed.txt"],
			movedFiles: [],
			fuzz: 0,
		},
		changes: [{ path: "removed.txt", kind: "delete", content: "gone\n" }],
		...overrides,
	});

	it("names committed deletes in a partial failure", () => {
		const value = result();
		const committed = applyPatchCommittedMessages(value, []);

		expect(applyPatchResultText(value, committed)).toContain("Removed removed.txt.");
	});

	it("warns when the native delta cannot describe the exact filesystem state", () => {
		expect(applyPatchResultText(result({ exact: false }), [])).toContain("unknown filesystem state");
	});

	it("shows both the removed source and overwritten move destination", () => {
		const diff = applyPatchChangeDiff({
			path: "source.txt",
			kind: "update",
			movePath: "destination.txt",
			oldContent: "source old\n",
			overwrittenMoveContent: "destination old\n",
			newContent: "moved new\n",
		});

		expect(diff).toContain("--- source.txt");
		expect(diff).toContain("-source old");
		expect(diff).toContain("--- destination.txt");
		expect(diff).toContain("-destination old");
		expect(diff).toContain("+moved new");
	});
});
