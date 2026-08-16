import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type Text } from "@earendil-works/pi-tui";
import { readPreviewImageFromPathSync } from "../shared/image-preview";
import { KittyVirtualImage } from "../shared/kitty-virtual-image";
import { registerExtensionMessageRenderer, textComponent } from "../shared/tui";
import type { ImageGenerationArgs } from "./image-gen";
import {
	IMAGE_SAVE_DISPLAY_MESSAGE_TYPE,
	type SavedGeneratedImage,
	type SurfacedWebSearch,
	WEB_SEARCH_ACTIVITY_MESSAGE_TYPE,
	WEB_SEARCH_TOOL_NAME,
} from "./native-tools";

const registeredRendererApis = new WeakSet<ExtensionAPI>();

function webSearchQueryText(search: SurfacedWebSearch): string {
	return search.queries.length > 0 ? search.queries.join(", ") : (search.query ?? "web");
}

function webSearchSources(searches: SurfacedWebSearch[]): Array<{ title?: string; url: string }> {
	const seen = new Set<string>();
	const sources: Array<{ title?: string; url: string }> = [];
	for (const search of searches) {
		for (const source of search.sources) {
			if (seen.has(source.url)) continue;
			seen.add(source.url);
			sources.push(source);
		}
	}
	return sources;
}

function webSearchSourceLabel(source: { title?: string; url: string }): string {
	const title = source.title?.trim();
	if (title) return title;
	try {
		return new URL(source.url).hostname.replace(/^www\./, "");
	} catch {
		return source.url;
	}
}

function shortenLabel(label: string): string {
	return label.length <= 48 ? label : `${label.slice(0, 45)}...`;
}

function renderWebSearchResultSummary(searches: SurfacedWebSearch[], theme: Theme): string | undefined {
	const sources = webSearchSources(searches);
	if (sources.length === 0) return undefined;
	const countLabel = sources.length === 1 ? "1 result" : `${sources.length} results`;
	const visibleLabels = sources.slice(0, 5).map((source) => shortenLabel(webSearchSourceLabel(source)));
	const hiddenCount = sources.length - visibleLabels.length;
	const labels = hiddenCount > 0 ? `${visibleLabels.join(", ")}, +${hiddenCount} more` : visibleLabels.join(", ");
	return `${theme.fg("accent", `${countLabel}:`)} ${theme.fg("muted", labels)}`;
}

function renderWebSearchActivity(searches: SurfacedWebSearch[], theme: Theme): string {
	const effectiveSearches = searches.length > 0 ? searches : [{ callId: "", queries: [], sources: [] }];
	const queryText = effectiveSearches.map(webSearchQueryText).join("; ");
	const resultSummary = renderWebSearchResultSummary(searches, theme);
	let text = `${theme.fg("success", "•")} ${theme.bold("Web Searched")} ${theme.fg("muted", queryText)}`;
	if (resultSummary) text += `${theme.fg("dim", " · ")}${resultSummary}`;
	return text;
}

function shortenPrompt(prompt: string, max = 96): string {
	const singleLine = prompt.replace(/\s+/g, " ").trim();
	return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max - 3)}...`;
}

export function createImageGenerationPresentation() {
	return {
		renderShell: "self" as const,
		renderCall(args: unknown, theme: Theme, context: { isPartial?: boolean; lastComponent?: unknown } | undefined) {
			const text = (context?.lastComponent as Text | undefined) ?? textComponent("");
			const running = context?.isPartial !== false;
			const prompt =
				typeof (args as ImageGenerationArgs)?.prompt === "string" ? (args as ImageGenerationArgs).prompt : "";
			const summary = prompt ? `${theme.fg("dim", " · ")}${theme.fg("muted", shortenPrompt(prompt))}` : "";
			text.setText(
				`${theme.fg(running ? "dim" : "success", "•")} ${theme.bold(running ? "Generating image" : "Generated image")}${summary}`,
			);
			return text;
		},
		renderResult(
			result: { content: Array<{ type: string; text?: string }> },
			{ expanded }: { expanded: boolean },
			theme: Theme,
		) {
			if (!expanded) return new Container();
			const text = result.content.find((item) => item.type === "text")?.text ?? "(no output)";
			return textComponent(theme.fg("dim", text));
		},
	};
}

export function createWebSearchPresentation() {
	return {
		renderCall(_args: unknown, theme: Theme) {
			return textComponent(theme.fg("toolTitle", theme.bold(WEB_SEARCH_TOOL_NAME)));
		},
		renderResult(
			result: { content: Array<{ type: string; text?: string }> },
			{ expanded }: { expanded: boolean },
			theme: Theme,
		) {
			if (!expanded) return new Container();
			const text = result.content.find((item) => item.type === "text")?.text ?? "(no output)";
			return textComponent(theme.fg("dim", text));
		},
	};
}

function renderGeneratedImageActivity(
	savedImage: SavedGeneratedImage,
	options: { expanded?: boolean },
	theme: Theme,
): string {
	const latest = theme.fg("muted", savedImage.latestRelativePath);
	let text = `${theme.fg("success", "•")} ${theme.bold("Generated image")}${theme.fg("dim", " · ")}${latest}`;
	if (!options.expanded) return text;
	const details: string[] = [];
	if (savedImage.revisedPrompt)
		details.push(
			`${theme.fg("accent", "Prompt")} ${theme.fg("muted", shortenPrompt(savedImage.revisedPrompt, 140))}`,
		);
	details.push(`${theme.fg("accent", "File")} ${theme.fg("muted", savedImage.relativePath)}`);
	details.push(`${theme.fg("accent", "Latest")} ${theme.fg("muted", savedImage.latestRelativePath)}`);
	for (const [index, detail] of details.entries()) {
		text += `\n${theme.fg("dim", index === details.length - 1 ? "  └ " : "  ├ ")}${detail}`;
	}
	return text;
}

export function renderImageGenerationMessage(
	message: { content: unknown; details?: { savedImages: SavedGeneratedImage[] } },
	options: { expanded?: boolean },
	theme: Theme,
) {
	const savedImage = message.details?.savedImages?.[0];
	const container = new Container();
	if (!savedImage) return textComponent(`${theme.fg("success", "•")} ${theme.bold("Generated image")}`);
	container.addChild(textComponent(renderGeneratedImageActivity(savedImage, options, theme)));
	const preview = readPreviewImageFromPathSync(savedImage.absolutePath);
	if (preview) {
		container.addChild(new Spacer(1));
		container.addChild(
			new KittyVirtualImage(
				preview.data,
				preview.mimeType,
				{ fallbackColor: (text) => theme.fg("toolOutput", text) },
				{ maxWidthCells: 80, maxHeightCells: 30, sourcePath: preview.sourcePath },
			),
		);
	}
	return container;
}

export function renderWebSearchMessage(
	message: { content: unknown; details?: { searches?: SurfacedWebSearch[] } },
	options: { expanded?: boolean },
	theme: Theme,
) {
	let text = renderWebSearchActivity(message.details?.searches ?? [], theme);
	if (options.expanded && typeof message.content === "string" && message.content.trim())
		text += `\n${theme.fg("dim", message.content)}`;
	return textComponent(text);
}

export function registerNativeActivityMessageRenderers(pi: ExtensionAPI): void {
	if (registeredRendererApis.has(pi)) return;
	registeredRendererApis.add(pi);
	registerExtensionMessageRenderer(pi, IMAGE_SAVE_DISPLAY_MESSAGE_TYPE, (message, options, theme) =>
		renderImageGenerationMessage(message as never, options, theme),
	);
	registerExtensionMessageRenderer(pi, WEB_SEARCH_ACTIVITY_MESSAGE_TYPE, (message, options, theme) =>
		renderWebSearchMessage(message as never, options, theme),
	);
}
