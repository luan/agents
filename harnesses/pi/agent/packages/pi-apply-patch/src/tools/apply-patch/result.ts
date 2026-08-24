import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ActionType, ExecutePatchError, ExecutePatchResult, ParsedPatchAction } from "../../types.ts";

export interface ApplyPatchOperation {
	operation: ActionType;
	path: string;
	movePath?: string;
}

export interface ApplyPatchFileResult extends ApplyPatchOperation {
	status: "applied" | "failed";
	message?: string;
}

interface ApplyPatchCounts {
	planned: number;
	applied: number;
	failed: number;
	changed: number;
	created: number;
	deleted: number;
	moved: number;
	fuzz: number;
}

interface ApplyPatchDetailsBase {
	version: 1;
	tool: "apply_patch";
	input: { operations: ApplyPatchOperation[] };
	affectedPaths: string[];
	files: ApplyPatchFileResult[];
	counts: ApplyPatchCounts;
	progress: { completed: number; total: number };
	timing: { durationMs: number };
}

export interface ApplyPatchRunningDetails extends ApplyPatchDetailsBase {
	status: "running";
}

export interface ApplyPatchSuccessDetails extends ApplyPatchDetailsBase {
	status: "success";
	result: ExecutePatchResult;
}

export interface ApplyPatchPartialFailureDetails extends ApplyPatchDetailsBase {
	status: "partial_failure";
	result: ExecutePatchResult;
	failure: { message: string; failedTargets: string[] };
}

export type ApplyPatchToolDetails =
	| ApplyPatchRunningDetails
	| ApplyPatchSuccessDetails
	| ApplyPatchPartialFailureDetails;

export function normalizePatchOperations(actions: readonly ParsedPatchAction[]): ApplyPatchOperation[] {
	return actions.map((action) => ({
		operation: action.type,
		path: action.path,
		...(action.movePath === undefined ? {} : { movePath: action.movePath }),
	}));
}

function summarize(result: ExecutePatchResult): string {
	return [
		"Applied patch successfully",
		`Changed files: ${result.changedFiles.length}`,
		`Created files: ${result.createdFiles.length}`,
		`Deleted files: ${result.deletedFiles.length}`,
		`Moved files: ${result.movedFiles.length}`,
		`Fuzz: ${result.fuzz}`,
	].join("\n");
}

function unique(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => value !== undefined && value.length > 0))];
}

function affectedPaths(operations: readonly ApplyPatchOperation[], result: ExecutePatchResult): string[] {
	return unique([
		...operations.flatMap((operation) => [operation.path, operation.movePath]),
		...result.changedFiles,
		...result.createdFiles,
		...result.deletedFiles,
		...result.movedFiles,
	]);
}

function counts(files: readonly ApplyPatchFileResult[], result: ExecutePatchResult): ApplyPatchCounts {
	return {
		planned: files.length,
		applied: files.filter((file) => file.status === "applied").length,
		failed: files.filter((file) => file.status === "failed").length,
		changed: result.changedFiles.length,
		created: result.createdFiles.length,
		deleted: result.deletedFiles.length,
		moved: result.movedFiles.length,
		fuzz: result.fuzz,
	};
}

function failedTargets(error: ExecutePatchError): string[] {
	return unique(error.failures.flatMap(({ action }) => [action.path, action.movePath]));
}

export function createApplyPatchRunningResult(
	operations: ApplyPatchOperation[],
): AgentToolResult<ApplyPatchRunningDetails> {
	const counts = {
		planned: operations.length,
		applied: 0,
		failed: 0,
		changed: 0,
		created: 0,
		deleted: 0,
		moved: 0,
		fuzz: 0,
	};
	return {
		content: [],
		details: {
			version: 1,
			tool: "apply_patch",
			status: "running",
			input: { operations },
			affectedPaths: unique(operations.flatMap((operation) => [operation.path, operation.movePath])),
			files: [],
			counts,
			progress: { completed: 0, total: operations.length },
			timing: { durationMs: 0 },
		},
	};
}

function partialFailureMessage(error: ExecutePatchError, failed: string[]): string {
	const lines = [`apply_patch partially failed: ${error.message}`];
	if (failed.length > 0) {
		lines.push(`Failed files: ${failed.join(", ")}`);
		lines.push(`Recovery: MUST read ${failed.join(", ")} before retrying`);
	}
	const applied = error.result.changedFiles.filter((path) => !failed.includes(path));
	if (applied.length > 0) {
		lines.push(`Already applied: ${applied.join(", ")}`);
		lines.push("Recovery: MUST NOT reapply the successful file actions");
	}
	return lines.join("\n");
}

export function createApplyPatchSuccessResult(
	result: ExecutePatchResult,
	operations: ApplyPatchOperation[],
	durationMs: number,
): AgentToolResult<ApplyPatchSuccessDetails> {
	const files: ApplyPatchFileResult[] = operations.map((operation) => ({ ...operation, status: "applied" }));
	return {
		content: [{ type: "text", text: summarize(result) }],
		details: {
			version: 1,
			tool: "apply_patch",
			status: "success",
			input: { operations },
			affectedPaths: affectedPaths(operations, result),
			files,
			counts: counts(files, result),
			progress: { completed: files.length, total: files.length },
			timing: { durationMs },
			result,
		},
	};
}

export function createApplyPatchPartialFailureResult(
	error: ExecutePatchError,
	operations: ApplyPatchOperation[],
	durationMs: number,
): AgentToolResult<ApplyPatchPartialFailureDetails> {
	const failed = failedTargets(error);
	const failureMessages = new Map(error.failures.map(({ action, message }) => [action.path, message]));
	const files: ApplyPatchFileResult[] = operations.map((operation) => {
		const isFailed =
			failed.includes(operation.path) || (operation.movePath !== undefined && failed.includes(operation.movePath));
		return {
			...operation,
			status: isFailed ? "failed" : "applied",
			...(isFailed ? { message: failureMessages.get(operation.path) ?? error.message } : {}),
		};
	});
	const completed = files.filter((file) => file.status === "applied").length;
	return {
		content: [{ type: "text", text: partialFailureMessage(error, failed) }],
		details: {
			version: 1,
			tool: "apply_patch",
			status: "partial_failure",
			input: { operations },
			affectedPaths: affectedPaths(operations, error.result),
			files,
			counts: counts(files, error.result),
			progress: { completed, total: files.length },
			timing: { durationMs },
			result: error.result,
			failure: { message: error.message, failedTargets: failed },
		},
	};
}
