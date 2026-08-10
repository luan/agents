import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, hyperlink, Markdown } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import { darkerCardBackgroundAnsi, framedBlock, renderStatusLine, textComponent, treeGlyphs } from "./shared/tui/card";

const PACKAGE_ENTRY = join(getAgentDir(), "npm/node_modules/@dreki-gg/pi-context7/extensions/context7/index.ts");

type Context7Tool = ToolDefinition<any, Record<string, unknown>>;
type ToolResult = Parameters<NonNullable<Context7Tool["renderResult"]>>[0];
type RenderTheme = Parameters<NonNullable<Context7Tool["renderCall"]>>[1];

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function compact(value: unknown, limit = 80): string {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function toolTitle(name: string): string {
	if (name.endsWith("resolve_library_id")) return "Context7 resolve";
	if (name.endsWith("get_cached_doc_raw")) return "Context7 raw docs";
	return "Context7 docs";
}

function callSummary(name: string, args: unknown): string {
	const input = record(args);
	const library = compact(input.libraryName ?? input.libraryId ?? input.docRef, 48);
	const query = compact(input.topic ?? input.query, 64);
	const page = typeof input.page === "number" ? `page ${input.page}` : "";
	return [library, query, page].filter(Boolean).join(" · ") || name.replace(/^context7_/, "");
}

function resultText(result: ToolResult): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
}

function resultSummary(result: ToolResult): string {
	const details = record(result.details);
	const candidates = Array.isArray(details.results)
		? `${details.results.length} match${details.results.length === 1 ? "" : "es"}`
		: "";
	return [
		compact(details.libraryName, 40),
		compact(details.libraryId ?? details.recommendedLibraryId, 48),
		compact(details.libraryVersion, 24),
		typeof details.page === "number" ? `page ${details.page}` : "",
		compact(details.cacheStatus ?? details.source, 24),
		candidates,
	]
		.filter(Boolean)
		.join(" · ");
}

function documentationPreview(text: string): [string, string?] {
	const lines = text.replace("Relevant documentation:###", "###").split("\n");
	const headingIndex = lines.findIndex((line) => line.trim().startsWith("###"));
	const heading =
		headingIndex >= 0 ? lines[headingIndex]!.trim().replace(/^#+\s*/, "") : compact(lines.find(Boolean), 100);
	const description = lines
		.slice(Math.max(0, headingIndex + 1))
		.map((line) => line.trim())
		.find(
			(line) =>
				line.length > 0 &&
				!line.startsWith("Source:") &&
				!line.startsWith("```") &&
				!line.startsWith("Raw cached document") &&
				!line.startsWith("Returned "),
		);
	return [compact(heading, 110), compact(description, 150) || undefined];
}

function docsLink(result: ToolResult, theme: RenderTheme): string | undefined {
	const details = record(result.details);
	const libraryId = details.libraryId ?? details.recommendedLibraryId;
	if (typeof libraryId !== "string" || !/^\/[^/\s]+\/[^/\s]+/.test(libraryId)) return undefined;
	const url = `https://context7.com${libraryId}`;
	const label = theme.fg("mdLink", "Open Context7 docs ↗");
	return getCapabilities().hyperlinks ? hyperlink(label, url) : `${label} ${theme.fg("dim", url)}`;
}

function resultPreview(toolName: string, result: ToolResult, text: string, theme: RenderTheme): string[] {
	const details = record(result.details);
	let lines: string[];
	if (toolName.endsWith("resolve_library_id") && Array.isArray(details.results)) {
		const recommendedId = compact(details.recommendedLibraryId, 60);
		const recommended = details.results
			.map(record)
			.find((candidate) => candidate.id === details.recommendedLibraryId);
		const title = compact(recommended?.title, 40);
		const description = compact(recommended?.description, 150);
		lines = [
			theme.fg("accent", recommendedId || title || "No recommendation"),
			theme.fg("muted", description || `${details.results.length} candidates`),
		];
	} else {
		const [heading, description] = documentationPreview(text);
		lines = [theme.fg("accent", heading), description ? theme.fg("muted", description) : ""].filter(Boolean);
	}
	const link = docsLink(result, theme);
	if (link) lines.push(link);
	const glyphs = treeGlyphs(theme);
	return lines.map((line, index) => `${index === lines.length - 1 ? glyphs.last : glyphs.branch} ${line}`);
}

function decorateTool(tool: Context7Tool): Context7Tool {
	return {
		...tool,
		renderShell: "self",
		renderCall(args, theme, context) {
			if (context?.isPartial === false) return new Container();
			return framedBlock(theme, {
				header: renderStatusLine(theme, {
					icon: context?.isError ? "error" : "pending",
					title: toolTitle(tool.name),
					description: callSummary(tool.name, args),
				}),
				borderColor: context?.isError ? "error" : "borderMuted",
				backgroundAnsi: darkerCardBackgroundAnsi(theme, context?.isError ? "toolErrorBg" : "toolPendingBg"),
			});
		},
		renderResult(result, options, theme, context) {
			const text = resultText(result);
			const error = context?.isError === true;
			const summary = resultSummary(result) || compact(text.split("\n")[0], 120);
			return framedBlock(theme, {
				header: renderStatusLine(theme, {
					icon: error ? "error" : "success",
					title: toolTitle(tool.name),
					description: summary,
				}),
				sections:
					options.expanded && text
						? [
								{
									component: error
										? textComponent(theme.fg("error", text))
										: new Markdown(text, 0, 0, getMarkdownTheme()),
								},
							]
						: [
								{
									lines: error
										? [theme.fg("error", compact(text, 180))]
										: resultPreview(tool.name, result, text, theme),
								},
							],
				borderColor: error ? "error" : "borderMuted",
				backgroundAnsi: darkerCardBackgroundAnsi(theme, error ? "toolErrorBg" : "toolPendingBg"),
			});
		},
	};
}

export default async function context7Renderer(pi: ExtensionAPI): Promise<void> {
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	const loaded = (await jiti.import(PACKAGE_ENTRY)) as {
		default?: (api: ExtensionAPI) => void | Promise<void>;
	};
	if (typeof loaded.default !== "function") throw new Error("Context7 package extension is unavailable");

	const wrapped = new Proxy(pi, {
		get(target, property, receiver) {
			if (property !== "registerTool") return Reflect.get(target, property, receiver);
			return (tool: Context7Tool) => target.registerTool(decorateTool(tool));
		},
	});
	await loaded.default(wrapped);
}
