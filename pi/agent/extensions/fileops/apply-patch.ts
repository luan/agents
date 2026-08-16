import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand } from "../shared/command-runner.ts";
import { workspaceBinary } from "../shared/workspace.ts";

export type ApplyPatchChange =
	| {
			path: string;
			kind: "add";
			content: string;
			overwrittenContent: string | null;
	  }
	| {
			path: string;
			kind: "delete";
			content: string;
	  }
	| {
			path: string;
			kind: "update";
			movePath: string | null;
			oldContent: string;
			overwrittenMoveContent: string | null;
			newContent: string;
	  };

export type ApplyPatchResult = {
	status: "success" | "failure";
	error: string | null;
	exact: boolean;
	result: {
		changedFiles: string[];
		createdFiles: string[];
		deletedFiles: string[];
		movedFiles: string[];
		fuzz: number;
	};
	changes: ApplyPatchChange[];
};

export function applyPatchBinaryPath(): string {
	return process.env.PI_APPLY_PATCH_BIN ?? workspaceBinary("apply_patch");
}

function parseApplyPatchResult(stdout: string, stderr: string): ApplyPatchResult {
	const line = stdout
		.trimEnd()
		.split(/\r?\n/)
		.findLast((row) => row.startsWith("{"));
	if (!line) {
		const message = stderr.trim() || stdout.trim() || "apply_patch returned no result.";
		throw new Error(message);
	}
	const value = JSON.parse(line) as Partial<ApplyPatchResult>;
	if (
		(value.status !== "success" && value.status !== "failure") ||
		typeof value.exact !== "boolean" ||
		!value.result ||
		!Array.isArray(value.changes)
	) {
		throw new Error("apply_patch returned an invalid result.");
	}
	return value as ApplyPatchResult;
}

export async function runApplyPatch(cwd: string, patch: string, signal?: AbortSignal): Promise<ApplyPatchResult> {
	const tempBase = join(tmpdir(), `pi-apply-patch-${randomUUID()}`);
	const inputPath = `${tempBase}.patch`;
	const outputPath = `${tempBase}.json`;
	try {
		await writeFile(inputPath, patch, "utf8");
		const result = await runCommand(applyPatchBinaryPath(), [], cwd, {
			signal,
			allowNonZero: true,
			env: {
				PI_APPLY_PATCH_INPUT_FILE: inputPath,
				PI_APPLY_PATCH_JSON: "1",
				PI_APPLY_PATCH_JSON_FILE: outputPath,
			},
		});
		const json = await readFile(outputPath, "utf8").catch(() => result.stdout);
		return parseApplyPatchResult(json, result.stderr);
	} finally {
		await Promise.all([rm(inputPath, { force: true }), rm(outputPath, { force: true })]);
	}
}
