import type { ExtensionAPI, ExtensionContext, MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { renderTranscriptPill, sanitizeTuiText, sanitizeTuiTextPreview } from "@luan.sh/pi-libtui";
import { installWebCitationPreviews, webCitationMarker, type WebCitationSource } from "./web-citation-preview.ts";

const WIDGET_KEY = "pi-codex-native.web-citations";

// type-boundary: Pi session/tool details are untyped; nestedWebText validates the optional libtui v1 snapshot.
type ToolDetails = unknown;

function nestedWebText(details: ToolDetails): string[] {
	if (!details || typeof details !== "object") return [];
	const snapshot: ToolDetails = Reflect.get(details, "libtuiNestedCalls");
	if (!snapshot || typeof snapshot !== "object" || Reflect.get(snapshot, "version") !== 1) return [];
	const calls: ToolDetails = Reflect.get(snapshot, "calls");
	if (!Array.isArray(calls)) return [];
	const texts: string[] = [];
	for (const saved of calls) {
		const call: ToolDetails = saved;
		if (!call || typeof call !== "object" || Reflect.get(call, "name") !== "web__run") continue;
		const result: ToolDetails = Reflect.get(call, "result");
		if (!result || typeof result !== "object") continue;
		const content: ToolDetails = Reflect.get(result, "content");
		if (!Array.isArray(content)) continue;
		for (const savedBlock of content) {
			const block: ToolDetails = savedBlock;
			if (!block || typeof block !== "object" || Reflect.get(block, "type") !== "text") continue;
			const text: ToolDetails = Reflect.get(block, "text");
			if (typeof text === "string") texts.push(text);
		}
	}
	return texts;
}

function collectSources(text: string, sources: Map<string, WebCitationSource>): void {
	// Web output places its citation ID immediately after the page title and URL.
	const matches = [
		...text.matchAll(
			/(?:^|\n)([^\r\n]*)\((https?:\/\/[^\s\u0000-\u001f\u007f]+)\)\r?\n\uE200cite\uE202(turn[\w-]+)\uE201/gu,
		),
	];
	for (const [index, match] of matches.entries()) {
		try {
			const url = new URL(match[2]!);
			if (url.username || url.password) continue;
			const body = text.slice(match.index + match[0].length, matches[index + 1]?.index);
			const preview = (body.includes("\n") ? body.slice(body.indexOf("\n") + 1) : "")
				.replace(/\uE200cite\uE202\d+†([^\uE201]*)\uE201/gu, "$1")
				.replace(/\uE200[^\uE201]*\uE201/gu, "")
				.replace(/(?:^|\n)L\d+:\s*/gu, " ");
			sources.set(match[3]!, {
				title: sanitizeTuiTextPreview(sanitizeTuiText(match[1]!).trim() || url.hostname, 200),
				url: url.href,
				preview: sanitizeTuiTextPreview(sanitizeTuiText(preview).replace(/\s+/gu, " ").trim(), 600),
			});
		} catch {
			// Malformed source URLs stay readable references, never terminal hyperlinks.
		}
	}
}

export function registerWebCitations(pi: Pick<ExtensionAPI, "on" | "registerMarkdownTransformer">): void {
	const sources = new Map<string, WebCitationSource>();
	let transcriptContext: ExtensionContext | undefined;
	let removePreview: (() => void) | undefined;
	const restore = (ctx: ExtensionContext): void => {
		sources.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			if (entry.message.toolName !== "web__run" && entry.message.toolName !== "codemode") continue;
			for (const block of entry.message.content) {
				if (block.type === "text") collectSources(block.text, sources);
			}
			for (const text of nestedWebText(entry.message.details)) collectSources(text, sources);
		}
	};
	pi.on("session_start", (_event, ctx) => {
		restore(ctx);
		transcriptContext = ctx.mode === "tui" ? ctx : undefined;
		removePreview?.();
		removePreview = undefined;
		if (!transcriptContext) return;
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			removePreview?.();
			const dispose = installWebCitationPreviews(tui, sources, () => ctx.ui.theme);
			removePreview = dispose;
			return {
				render: () => [],
				invalidate() {},
				dispose() {
					dispose();
					if (removePreview === dispose) removePreview = undefined;
				},
			};
		});
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		removePreview?.();
		removePreview = undefined;
		transcriptContext = undefined;
		sources.clear();
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
	pi.on("tool_result", (event) => {
		if (event.isError || event.toolName !== "web__run") return;
		for (const block of event.content) {
			if (block.type === "text") collectSources(block.text, sources);
		}
	});
	const transform: MarkdownTransformer = (markdown, context) => {
		if (context.messageType === "user") return markdown;
		const rendered = markdown.replace(/\uE200cite\uE202([^\uE201]*)\uE201/gu, (_token, references: string) => {
			const ids = [...new Set(references.split("\uE202"))].filter((id) => /^turn[\w-]+$/u.test(id));
			if (!ids.length) return "[source unavailable]";
			return ids
				.map((id) => {
					const source = sources.get(id);
					if (!source) return `[${id}]`;
					if (!transcriptContext)
						return `[${source.title.replace(/[\\[\]]/g, "\\$&")}](${source.url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
					return webCitationMarker(
						renderTranscriptPill(
							transcriptContext.ui.theme,
							// Literal table separators must not create Markdown columns; hover keeps the full title.
							{ icon: "search", label: source.title.replaceAll("|", "·") },
							Math.min(context.availableWidth, 36),
							context.messageType === "assistant-thinking",
							{ surface: "assistant", href: source.url },
						),
						id,
					);
				})
				.join(" ");
		});
		return rendered.replace(/\uE200[^\uE201]*$/u, context.isStreaming ? "" : "[source unavailable]");
	};
	pi.registerMarkdownTransformer(transform);
}
