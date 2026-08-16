import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";
import { type PreviewImage, readPreviewImageFromPathSync } from "../shared/image-preview";
import { KittyVirtualImage } from "../shared/kitty-virtual-image";
import {
	type AnimationMount,
	type RenderTheme,
	registerExtensionMessageRenderer,
	sharedAnimationRenderScheduler,
	textComponent,
} from "../shared/tui";

const RENDER_TARGET_WIDGET_KEY = "image-attach-render";
const PENDING_FRAME_MS = 120;

type RenderTarget = { requestRender(): void };

type WidgetUi = {
	setWidget?: (
		key: string,
		content: ((tui: RenderTarget) => { render: () => string[]; invalidate: () => void }) | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	) => void;
};

let renderTarget: RenderTarget | undefined;
const previewCache = new Map<string, PreviewImage | undefined>();

export function claimImageRenderTarget(ctx: ExtensionContext): void {
	const ui = ctx.ui as unknown as WidgetUi;
	if (typeof ui.setWidget !== "function") return;
	ui.setWidget(
		RENDER_TARGET_WIDGET_KEY,
		(tui) => {
			renderTarget = tui;
			return { render: () => [], invalidate: () => {} };
		},
		{ placement: "belowEditor" },
	);
}

export function requestImageRender(): void {
	renderTarget?.requestRender();
}

export function startPendingImageAnimation(): AnimationMount | undefined {
	requestImageRender();
	return renderTarget && sharedAnimationRenderScheduler.mount(renderTarget, PENDING_FRAME_MS);
}

function cachedPreview(path: string): PreviewImage | undefined {
	if (!previewCache.has(path)) previewCache.set(path, readPreviewImageFromPathSync(path));
	return previewCache.get(path);
}

function renderPreviewMessage(paths: readonly string[], theme: RenderTheme): Container {
	const container = new Container();
	for (const [index, path] of paths.entries()) {
		if (index > 0) container.addChild(new Spacer(1));
		const label = theme.bold?.("Attached image") ?? "Attached image";
		container.addChild(
			textComponent(
				`${theme.fg("success", "•")} ${label}${theme.fg("dim", " · ")}${theme.fg("muted", basename(path))}`,
			),
		);
		const preview = cachedPreview(path);
		if (preview) {
			container.addChild(
				new KittyVirtualImage(
					preview.data,
					preview.mimeType,
					{ fallbackColor: (fallback) => theme.fg("toolOutput", fallback) },
					{ maxWidthCells: 80, maxHeightCells: 30, sourcePath: preview.sourcePath },
				),
			);
		}
	}
	return container;
}

export function registerImagePreviewRenderer(pi: ExtensionAPI, messageType: string): void {
	registerExtensionMessageRenderer(pi, messageType, (message, _options, theme) => {
		const paths = (message.details as { paths?: string[] } | undefined)?.paths ?? [];
		return renderPreviewMessage(paths, theme as unknown as RenderTheme);
	});
}

export function clearImagePresentation(): void {
	previewCache.clear();
	renderTarget = undefined;
}
