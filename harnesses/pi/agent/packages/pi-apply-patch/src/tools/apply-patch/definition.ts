import { type ExtensionAPI, type ToolDefinition, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { executePatchWithRust } from "../../executor.ts";
import { APPLY_PATCH_CONSTRAINED_SAMPLING } from "../../grammar.ts";
import { parsePatchActions, resolvePatchPath } from "../../patch.ts";
import { ExecutePatchError } from "../../types.ts";
import { renderApplyPatchCall, renderApplyPatchResult } from "./presentation.ts";
import {
	type ApplyPatchOperation,
	type ApplyPatchToolDetails,
	createApplyPatchPartialFailureResult,
	createApplyPatchRunningResult,
	createApplyPatchSuccessResult,
	normalizePatchOperations,
} from "./result.ts";

const APPLY_PATCH_PARAMETERS = {
	type: "object",
	properties: {
		input: {
			type: "string",
			description: "Full patch text. Use *** Begin Patch and *** End Patch with Add, Update, or Delete File sections.",
		},
	},
	required: ["input"],
	additionalProperties: false,
} as const;

type ApplyPatchToolDefinition = ToolDefinition<typeof APPLY_PATCH_PARAMETERS, ApplyPatchToolDetails>;

function parseParameters(params: unknown): string {
	if (!params || typeof params !== "object" || !("input" in params) || typeof params.input !== "string") {
		throw new Error("apply_patch requires a string 'input' parameter");
	}
	return params.input;
}

function prepareArguments(args: unknown): { input: string } {
	if (args && typeof args === "object") {
		if ("input" in args && typeof args.input === "string") return { input: args.input };
		if ("patchText" in args && typeof args.patchText === "string") return { input: args.patchText };
		if ("patch" in args && typeof args.patch === "string") return { input: args.patch };
	}
	return args as { input: string };
}

function touchedPaths(cwd: string, patchText: string): string[] {
	try {
		return [
			...new Set(
				parsePatchActions(patchText)
					.flatMap((action) => [action.path, action.movePath])
					.filter((path): path is string => path !== undefined)
					.map((path) => resolvePatchPath(cwd, path)),
			),
		].sort();
	} catch {
		return [];
	}
}

function withMutationQueues<T>(paths: string[], run: () => Promise<T>): Promise<T> {
	const enter = (index: number): Promise<T> =>
		index >= paths.length ? run() : withFileMutationQueue(paths[index]!, () => enter(index + 1));
	return enter(0);
}

export function createApplyPatchTool(): ApplyPatchToolDefinition {
	return {
		name: "apply_patch",
		label: "apply_patch",
		description: `Use apply_patch for manual file edits. This is a freeform tool, so do not wrap the patch in JSON.
Apply a structured patch to files in the workspace.
Start the input with *** Begin Patch and end it with *** End Patch. Use *** Add File, *** Update File, or *** Delete File for each file. Put *** Move to immediately after its *** Update File header. Order multiple hunks for one file from top to bottom. Indentation and context lines are literal. After a partial failure, keep successful edits and retry only failed edits against freshly read files.`,
		parameters: APPLY_PATCH_PARAMETERS,
		constrainedSampling: APPLY_PATCH_CONSTRAINED_SAMPLING,
		executionMode: "sequential",
		renderShell: "self",
		prepareArguments,
		renderCall(args, theme, context) {
			return renderApplyPatchCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			const patchText =
				context.args &&
				typeof context.args === "object" &&
				"input" in context.args &&
				typeof context.args.input === "string"
					? context.args.input
					: "";
			return renderApplyPatchResult(result, options, theme, context, patchText);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) throw new Error("apply_patch aborted");
			const patchText = parseParameters(params);
			const startedAt = performance.now();
			let operations: ApplyPatchOperation[] = [];
			try {
				operations = normalizePatchOperations(parsePatchActions(patchText));
			} catch {
				// Rust owns authoritative parsing and error reporting.
			}
			onUpdate?.(createApplyPatchRunningResult(operations));
			try {
				const result = await withMutationQueues(touchedPaths(ctx.cwd, patchText), () =>
					executePatchWithRust({ cwd: ctx.cwd, patchText, signal }),
				);
				return createApplyPatchSuccessResult(result, operations, performance.now() - startedAt);
			} catch (error) {
				if (!(error instanceof ExecutePatchError) || !error.hasPartialSuccess()) throw error;
				return createApplyPatchPartialFailureResult(error, operations, performance.now() - startedAt);
			}
		},
	};
}

export function registerApplyPatchTool(pi: ExtensionAPI, tool = createApplyPatchTool()): void {
	pi.registerTool(tool);
}

export function registerApplyPatchResultEvent(pi: ExtensionAPI): void {
	pi.on("tool_result", (event) => {
		const details = event.details as Partial<ApplyPatchToolDetails> | undefined;
		if (event.toolName === "apply_patch" && details?.status === "partial_failure") {
			return { isError: true };
		}
		return undefined;
	});
}
