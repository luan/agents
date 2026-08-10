import type { Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { EmptyComponent } from "../../shared/tui";
import { framedBlock, renderStatusLine } from "../../shared/tui/card.js";
import { invokeCore, type PiToolResponse } from "./core.js";
import { getStorePath } from "./tool-paths.js";
import { createPiToolSpecs, parseToolParams } from "./tool-specs.js";

interface PiRenderTheme {
	bold(text: string): string;
	fg(color: string, text: string): string;
	getBgAnsi?(color: "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg"): string;
	styledSymbol?(name: string, color: string): string;
}

type PiRenderContext = {
	args?: Record<string, unknown>;
	isPartial?: boolean;
	isError?: boolean;
};
type ToolResult = PiToolResponse & { isError?: boolean };

type DirectToolDef = {
	name: "cg_search" | "cg_status" | "cg_purge";
	description: string;
	inputSchema: TSchema;
	handler: (params: Record<string, unknown>, projectDir?: string) => Promise<ToolResult>;
};

const toolSpecs = createPiToolSpecs();
const DIRECT_TOOLS: DirectToolDef[] = [
	{
		name: "cg_search",
		description: toolSpecs.search.description,
		inputSchema: toolSpecs.search.inputSchema,
		handler: (params, projectDir) => invokeCore("search", { dbPath: getStorePath(projectDir), ...params }),
	},
	{
		name: "cg_status",
		description: toolSpecs.status.description,
		inputSchema: toolSpecs.status.inputSchema,
		handler: (_params, projectDir) => invokeCore("status", { dbPath: getStorePath(projectDir) }),
	},
	{
		name: "cg_purge",
		description: toolSpecs.purge.description,
		inputSchema: toolSpecs.purge.inputSchema,
		handler: (params, projectDir) => invokeCore("purge", { dbPath: getStorePath(projectDir), ...params }),
	},
];

const EMPTY_VIEW = new EmptyComponent();

function outputText(result: PiToolResponse): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function parseOutput(result: PiToolResponse): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(outputText(result));
		return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function argumentDescription(toolName: DirectToolDef["name"], args: Record<string, unknown> = {}): string {
	if (toolName === "cg_search") {
		if (typeof args.query === "string") return args.query;
		if (Array.isArray(args.queries)) return args.queries.join(", ");
		if (typeof args.artifactId === "string") return `artifact ${args.artifactId.slice(0, 12)}`;
		return "captured output";
	}
	if (toolName === "cg_purge") return typeof args.scope === "string" ? args.scope : "captured output";
	return "capture store";
}

function renderCall(
	toolName: DirectToolDef["name"],
	args: Record<string, unknown>,
	theme: PiRenderTheme,
	context: PiRenderContext,
): Component {
	if (context.isPartial !== true) return EMPTY_VIEW;
	const title =
		toolName === "cg_search"
			? "Searching context"
			: toolName === "cg_status"
				? "Reading context status"
				: "Purging context";
	return framedBlock(theme, {
		header: renderStatusLine(theme, {
			icon: "pending",
			title,
			description: argumentDescription(toolName, args),
		}),
		borderColor: "accent",
		backgroundColor: "toolPendingBg",
	});
}

function renderSearchResult(
	data: Record<string, unknown>,
	args: Record<string, unknown>,
	expanded: boolean,
	theme: PiRenderTheme,
): Component {
	const results = Array.isArray(data.results) ? data.results.filter((item) => item && typeof item === "object") : [];
	const shown = expanded ? results : results.slice(0, 5);
	const sections: Array<{ label?: string; lines: string[] }> = shown.map((value, index) => {
		const item = value as Record<string, unknown>;
		const snippet = typeof item.snippet === "string" ? item.snippet.split(/\r?\n/) : [];
		const visibleSnippet = expanded ? snippet : snippet.slice(0, 4);
		const source = typeof item.source === "string" ? item.source : "";
		const kind = typeof item.sourceKind === "string" ? item.sourceKind : "";
		const capture = typeof item.captureId === "number" ? `capture ${item.captureId}` : "";
		const chunk = typeof item.chunkIndex === "number" ? `chunk ${item.chunkIndex}` : "";
		const metadata = [kind, source, capture, chunk].filter(Boolean).join(" · ");
		return {
			label: `${index + 1}. ${typeof item.label === "string" && item.label ? item.label : "Captured output"}`,
			lines: [
				...(metadata ? [theme.fg("dim", metadata)] : []),
				...visibleSnippet.map((line) => theme.fg("toolOutput", line)),
				...(!expanded && snippet.length > visibleSnippet.length
					? [theme.fg("dim", `… +${snippet.length - visibleSnippet.length} lines`)]
					: []),
			],
		};
	});
	if (sections.length === 0) sections.push({ lines: [theme.fg("muted", "No captured output matched.")] });
	return framedBlock(theme, {
		header: renderStatusLine(theme, {
			icon: "success",
			title: "Context search",
			description: argumentDescription("cg_search", args),
			meta: [`${results.length} result${results.length === 1 ? "" : "s"}`],
		}),
		sections,
		borderColor: "borderMuted",
		backgroundColor: "toolSuccessBg",
	});
}

function formatBytes(value: unknown): string {
	const bytes = typeof value === "number" ? value : 0;
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderStatusResult(data: Record<string, unknown>, theme: PiRenderTheme): Component {
	return framedBlock(theme, {
		header: renderStatusLine(theme, {
			icon: "success",
			title: "Context status",
			description: data.exists === false ? "empty store" : "capture store",
			meta: [`${Number(data.captures ?? 0)} captures`, `${Number(data.artifacts ?? 0)} artifacts`],
		}),
		sections: [
			{
				lines: [
					`Indexed: ${formatBytes(data.indexedBytes)}`,
					`Database: ${formatBytes(data.databaseBytes)}`,
					`Searches: ${Number(data.searchCalls ?? 0)} · failures: ${Number(data.searchFailures ?? 0)}`,
					`Captures: ${Number(data.captureCalls ?? 0)} · failures: ${Number(data.captureFailures ?? 0)}`,
				].map((line) => theme.fg("toolOutput", line)),
			},
		],
		borderColor: "borderMuted",
		backgroundColor: "toolSuccessBg",
	});
}

function renderPurgeResult(data: Record<string, unknown>, theme: PiRenderTheme): Component {
	const scope = typeof data.scope === "string" ? data.scope : "unknown";
	const count = typeof data.deleted === "number" ? `${data.deleted} captures deleted` : "store deleted";
	return framedBlock(theme, {
		header: renderStatusLine(theme, { icon: "success", title: "Context purge", description: scope, meta: [count] }),
		borderColor: "borderMuted",
		backgroundColor: "toolSuccessBg",
	});
}

function renderResult(
	toolName: DirectToolDef["name"],
	result: PiToolResponse,
	state: { expanded: boolean; isPartial: boolean },
	theme: PiRenderTheme,
	context: PiRenderContext,
): Component {
	if (state.isPartial) return EMPTY_VIEW;
	const data = parseOutput(result);
	if (data) {
		if (toolName === "cg_search") return renderSearchResult(data, context.args ?? {}, state.expanded, theme);
		if (toolName === "cg_status") return renderStatusResult(data, theme);
		return renderPurgeResult(data, theme);
	}
	return framedBlock(theme, {
		header: renderStatusLine(theme, {
			icon: context.isError ? "error" : "success",
			title:
				toolName === "cg_search" ? "Context search" : toolName === "cg_status" ? "Context status" : "Context purge",
		}),
		sections: [
			{
				lines: outputText(result)
					.split(/\r?\n/)
					.map((line) => theme.fg("toolOutput", line)),
			},
		],
		borderColor: context.isError ? "error" : "borderMuted",
		backgroundColor: context.isError ? "toolErrorBg" : "toolSuccessBg",
	});
}

export function registerPiContextTools(pi: {
	registerTool: (def: {
		name: string;
		label: string;
		description: string;
		parameters: Record<string, unknown>;
		renderShell?: "self";
		renderCall?: (_args: unknown, theme: PiRenderTheme, context: PiRenderContext) => unknown;
		renderResult?: (
			result: PiToolResponse,
			state: { expanded: boolean; isPartial: boolean },
			theme: PiRenderTheme,
			context: PiRenderContext,
		) => unknown;
		execute: (
			_toolCallId: string,
			params: unknown,
			_signal?: AbortSignal,
			_onUpdate?: unknown,
			ctx?: { cwd?: string },
		) => Promise<PiToolResponse>;
	}) => void;
}): void {
	for (const def of DIRECT_TOOLS) {
		pi.registerTool({
			name: def.name,
			label: `Context: ${def.name.slice(3)}`,
			description: def.description,
			parameters: def.inputSchema as unknown as Record<string, unknown>,
			renderShell: "self",
			renderCall: (args, theme, context) => renderCall(def.name, args as Record<string, unknown>, theme, context),
			renderResult: (result, state, theme, context) => renderResult(def.name, result, state, theme, context),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				try {
					const result = await def.handler(
						parseToolParams(def.inputSchema, params) as Record<string, unknown>,
						ctx?.cwd,
					);
					const text = result.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
					if (result.isError) throw new Error(text || `${def.name} returned an error`);
					return { content: [{ type: "text", text }], details: result.details };
				} catch (error) {
					if (def.name === "cg_search") {
						try {
							await invokeCore("record_failure", { dbPath: getStorePath(ctx?.cwd), operation: "search" });
						} catch {
							// The core may be unavailable; retrieval errors remain visible.
						}
					}
					throw error;
				}
			},
		});
	}
}
