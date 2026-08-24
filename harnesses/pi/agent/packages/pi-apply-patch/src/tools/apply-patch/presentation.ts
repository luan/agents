import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { ComponentStack, icon } from "pi-libtui";
import {
	createUnifiedDiffModel,
	parseUnifiedDiff,
	type UnifiedDiffFileInput,
	type UnifiedDiffHunkInput,
	type UnifiedDiffModel,
	type UnifiedDiffRowInput,
} from "pi-libtui/diff";
import { settleToolCallPreview, ToolActivity, type ToolTranscriptStatus, toolCallPreview } from "pi-libtui/tool";
import { parsePatchActions } from "../../patch.ts";
import type { ParsedPatchAction } from "../../types.ts";
import type { ApplyPatchToolDetails } from "./result.ts";

const PATCH_PREVIEW_CACHE_LIMIT = 8;
const PATCH_PREVIEW_MAX_CHARACTERS = 1_000_000;
const patchPreviewCache = new Map<string, { source: string; model: UnifiedDiffModel }>();

interface ApplyPatchRenderContext {
	readonly executionStarted: boolean;
	readonly state?: object;
	readonly isError: boolean;
	readonly invalidate?: () => void;
	readonly lastComponent?: object;
}

export function renderApplyPatchCall(args: { input?: string } | null, theme: Theme, context: ApplyPatchRenderContext) {
	if (context.executionStarted) return new ComponentStack();
	return toolCallPreview(
		context.state ?? context,
		createPatchActivity(
			theme,
			() => {},
			patchActivityView(patchPreviewModel(typeof args?.input === "string" ? args.input : ""), "queued", false),
		),
	);
}

export function renderApplyPatchResult(
	result: AgentToolResult<ApplyPatchToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ApplyPatchRenderContext,
	patchText: string,
) {
	settleToolCallPreview(context.state ?? context);
	const details = result.details;
	const validDetails = isApplyPatchDetails(details);
	const status: ToolTranscriptStatus = !validDetails
		? "failed"
		: details.status === "running"
			? options.isPartial
				? "running"
				: context.isError
					? "failed"
					: "succeeded"
			: details.status === "partial_failure"
				? "warning"
				: context.isError
					? "failed"
					: "succeeded";
	const preview = patchPreviewModel(patchText);
	const model =
		validDetails && details.status !== "running" && details.result.diff
			? parseUnifiedDiff(details.result.diff)
			: preview;
	const warning = !validDetails
		? (Array.isArray(result.content) ? result.content : []).find((item): item is { type: "text"; text: string } =>
				Boolean(item && typeof item === "object" && item.type === "text" && typeof item.text === "string"),
			)?.text || "Edit failed"
		: details.status === "partial_failure"
			? details.failure.message
			: undefined;
	if (context.lastComponent instanceof ToolActivity) {
		context.lastComponent.update(patchActivityView(model, status, options.expanded, warning));
		return context.lastComponent;
	}
	return createPatchActivity(
		theme,
		context.invalidate ?? (() => {}),
		patchActivityView(model, status, options.expanded, warning),
	);
}

function isApplyPatchDetails(details: ApplyPatchToolDetails | undefined): details is ApplyPatchToolDetails {
	if (!details || typeof details !== "object") return false;
	if (details.version !== 1 || details.tool !== "apply_patch") return false;
	if (details.status === "running" || details.status === "success") return true;
	return details.status === "partial_failure" && typeof details.failure?.message === "string";
}

function patchActivityView(model: UnifiedDiffModel, status: ToolTranscriptStatus, expanded: boolean, warning?: string) {
	const deleted = model.files.length > 0 && model.files.every((file) => file.headerLines.includes("file deleted"));
	return {
		action: {
			verb: deleted
				? "Deleted"
				: status === "running" || status === "queued"
					? "Editing"
					: status === "failed"
						? "Edit failed"
						: status === "warning"
							? "Partially edited"
							: "Edited",
			status,
			detail: fileSummary(model),
			meta: deleted
				? ["file deleted"]
				: model.additions || model.removals
					? [`+${model.additions} −${model.removals}`]
					: undefined,
			marker: status === "failed" ? undefined : status === "warning" ? icon("warning") : icon("edit"),
		},
		running: status === "running",
		failure: warning,
		payload: deleted ? undefined : { kind: "diff" as const, model },
		mode: expanded ? ("full" as const) : ("preview" as const),
	};
}

function createPatchActivity(
	theme: Theme,
	requestRender: () => void,
	view: ReturnType<typeof patchActivityView>,
): ToolActivity {
	return new ToolActivity({
		theme,
		requestRender,
		view,
		fullRows: 2_000,
	});
}

function fileSummary(model: UnifiedDiffModel): string {
	const paths = model.files.map((file) => file.newPath ?? file.oldPath).filter((path): path is string => Boolean(path));
	if (paths.length === 0) return "patch";
	if (paths.length === 1) return paths[0]!;
	return `${paths[0]} and ${paths.length - 1} more`;
}

export function patchPreviewModel(patchText: string): UnifiedDiffModel {
	const inputTruncated = patchText.length > PATCH_PREVIEW_MAX_CHARACTERS;
	const previewText = inputTruncated ? `${patchText.slice(0, PATCH_PREVIEW_MAX_CHARACTERS)}\n*** End Patch` : patchText;
	const cacheKey = `${previewText.length}:${hash(previewText)}`;
	const cached = patchPreviewCache.get(cacheKey);
	if (cached?.source === previewText) {
		patchPreviewCache.delete(cacheKey);
		patchPreviewCache.set(cacheKey, cached);
		return cached.model;
	}
	let model: UnifiedDiffModel;
	try {
		model = createUnifiedDiffModel(parsePatchActions(previewText).map(actionDiff), { truncated: inputTruncated });
	} catch {
		model = createUnifiedDiffModel([], { revision: previewText, truncated: inputTruncated });
	}
	patchPreviewCache.set(cacheKey, { source: previewText, model });
	while (patchPreviewCache.size > PATCH_PREVIEW_CACHE_LIMIT) {
		const oldest = patchPreviewCache.keys().next().value;
		if (oldest === undefined) break;
		patchPreviewCache.delete(oldest);
	}
	return model;
}

function hash(value: string): string {
	let result = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		result ^= value.charCodeAt(index);
		result = Math.imul(result, 16_777_619);
	}
	return (result >>> 0).toString(36);
}

function actionDiff(action: ParsedPatchAction): UnifiedDiffFileInput {
	if (action.type === "add") {
		const added = lines(action.newFile ?? "");
		return {
			newPath: action.path,
			hunks: [
				{
					header: `@@ -0,0 +1,${added.length} @@`,
					newStart: 1,
					newCount: added.length,
					rows: added.map((text) => ({ kind: "added", text })),
				},
			],
		};
	}
	if (action.type === "delete") {
		return {
			oldPath: action.path,
			headerLines: ["file deleted"],
			hunks: [],
		};
	}
	return {
		oldPath: action.path,
		newPath: action.movePath ?? action.path,
		headerLines: action.movePath ? [`rename ${action.path} → ${action.movePath}`] : undefined,
		hunks: patchHunks(action.lines ?? []),
	};
}

function patchHunks(source: readonly string[]): UnifiedDiffHunkInput[] {
	const hunks: UnifiedDiffHunkInput[] = [];
	let current: { header?: string; rows: UnifiedDiffRowInput[] } = { rows: [] };
	const finish = (): void => {
		if (current.rows.length === 0) return;
		hunks.push({
			// A bare @@ is apply_patch grammar. createUnifiedDiffModel will
			// synthesize a valid range from these rows before handing it to
			// Pierre; real unified headers remain opaque and Pierre parses them.
			header: current.header,
			...(current.header ? {} : { oldStart: 1, newStart: 1 }),
			rows: current.rows,
		});
	};
	for (const line of source) {
		if (isUnifiedHunkHeader(line)) {
			finish();
			current = { header: line, rows: [] };
			continue;
		}
		// Bare @@ is a non-unified apply_patch separator. It deliberately does
		// not split the logical change: apply_patch permits repeated separators
		// while Pierre owns the actual unified hunk/range semantics downstream.
		if (line.startsWith("@@")) {
			continue;
		}
		const marker = line[0];
		const kind = marker === "+" ? "added" : marker === "-" ? "removed" : marker === " " ? "context" : "metadata";
		current.rows.push({
			kind,
			text: kind === "metadata" ? line : line.slice(1),
		});
	}
	finish();
	return hunks;
}

/** Recognize a unified header without interpreting its numeric ranges. */
function isUnifiedHunkHeader(line: string): boolean {
	return line.startsWith("@@ -") && line.includes(" +") && line.includes(" @@");
}

function lines(value: string): string[] {
	const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
	return normalized ? normalized.split("\n") : [];
}
