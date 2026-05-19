import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { startMarkdownAnnotationSession } from "@plannotator/pi-extension/plannotator-events.js";
import { Type } from "typebox";

const IMAGE_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg",
	".bmp",
	".ico",
	".tiff",
	".tif",
	".avif",
]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const REVIEW_ARTIFACT_DIR = join(tmpdir(), "pi-review-artifacts");
const CHROME_CANDIDATES = [
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/snap/bin/chromium",
	"google-chrome",
	"chromium",
	"chromium-browser",
] as const;
const HTML_SCREENSHOT_VIEWPORTS = [
	{ name: "desktop", width: 1440, height: 1024 },
	{ name: "mobile", width: 390, height: 844 },
] as const;

type TextResult = {
	content: [{ type: "text"; text: string }];
	details?: Record<string, unknown>;
};

type AnnotationResult = {
	feedback?: string;
	exit?: boolean;
	approved?: boolean;
	savedPath?: string;
};

type AnnotationSessionStarter = typeof startMarkdownAnnotationSession;

class EmptyRender implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

const emptyRender = new EmptyRender();
let startAnnotationSession: AnnotationSessionStarter = startMarkdownAnnotationSession;

function commonTool() {
	return {
		renderShell: "self" as const,
		renderCall: () => emptyRender,
		renderResult: () => emptyRender,
	};
}

function textResult(text: string, details?: Record<string, unknown>): TextResult {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function ensureUiAvailable(ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		throw new Error("Plannotator review requires a Pi UI session.");
	}
}

export function resolveHtmlReviewTarget(rawTarget: string, cwd: string): string {
	const trimmed = rawTarget.trim();
	if (!trimmed) throw new Error("HTML review requires a file path.");
	const resolvedPath = resolve(cwd, trimmed);
	const stats = statSync(resolvedPath, { throwIfNoEntry: false });
	if (!stats) throw new Error(`HTML file not found: ${resolvedPath}`);
	if (!stats.isFile()) throw new Error(`HTML review expects a file, got: ${resolvedPath}`);
	if (!HTML_EXTENSIONS.has(extname(resolvedPath).toLowerCase())) {
		throw new Error(`HTML review expects .html or .htm, got: ${resolvedPath}`);
	}
	return resolvedPath;
}

function shouldSkipDirectory(name: string): boolean {
	return name === "node_modules" || name.startsWith(".");
}

function collectImageFiles(root: string): string[] {
	const results: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) {
				if (!shouldSkipDirectory(entry.name)) stack.push(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
			results.push(fullPath);
		}
	}
	return results.sort((left, right) => left.localeCompare(right));
}

function encodeImageUrl(absolutePath: string): string {
	return `./api/image?path=${encodeURIComponent(absolutePath)}`;
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function buildImageReviewHtml(
	targetPath: string,
	imagePaths: string[],
	options?: {
		title?: string;
		intro?: string;
	},
): string {
	const singleImage = imagePaths.length === 1 && IMAGE_EXTENSIONS.has(extname(targetPath).toLowerCase());
	const rootPath = singleImage ? dirname(targetPath) : targetPath;
	const title = options?.title ?? `Image review: ${basename(targetPath)}`;
	const intro =
		options?.intro ??
		"Review the image set below. Use annotations to point out visual regressions, layout issues, or naming mistakes.";
	const sections = [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8" />',
		`<title>${escapeHtml(title)}</title>`,
		"<style>",
		"body { font-family: Inter, ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0b1020; color: #e5e7eb; }",
		"main { max-width: 1200px; margin: 0 auto; padding: 32px 24px 64px; }",
		"h1, h2, p, dt, dd, figcaption, code { margin: 0; }",
		"header { margin-bottom: 24px; }",
		"p { color: #cbd5e1; line-height: 1.6; }",
		"dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 20px 0 0; }",
		".meta { background: #111827; border: 1px solid #334155; border-radius: 12px; padding: 12px 14px; }",
		"dt { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #94a3b8; margin-bottom: 6px; }",
		"dd code { white-space: pre-wrap; word-break: break-word; font-size: 13px; color: #f8fafc; }",
		".gallery { display: grid; gap: 20px; }",
		"section { background: #111827; border: 1px solid #334155; border-radius: 16px; padding: 16px; }",
		"h2 { font-size: 18px; margin-bottom: 12px; }",
		"figure { margin: 0; }",
		"img { display: block; max-width: 100%; height: auto; border-radius: 10px; background: #020617; }",
		"figcaption { margin-top: 10px; font-size: 13px; color: #94a3b8; }",
		"</style>",
		"</head>",
		"<body>",
		"<main>",
		"<header>",
		`<h1>${escapeHtml(title)}</h1>`,
		`<p>${escapeHtml(intro)}</p>`,
		"<dl>",
		`<div class="meta"><dt>Source ${singleImage ? "image" : "folder"}</dt><dd><code>${escapeHtml(targetPath)}</code></dd></div>`,
		`<div class="meta"><dt>Image count</dt><dd><code>${imagePaths.length}</code></dd></div>`,
		"</dl>",
		"</header>",
		'<div class="gallery">',
	];
	for (const imagePath of imagePaths) {
		const label = singleImage ? basename(imagePath) : relative(rootPath, imagePath) || basename(imagePath);
		const escapedLabel = escapeHtml(label);
		const imageUrl = encodeImageUrl(imagePath);
		sections.push(
			"<section>",
			`<h2>${escapedLabel}</h2>`,
			"<figure>",
			`<img alt="${escapedLabel}" src="${imageUrl}" />`,
			`<figcaption>${escapedLabel}</figcaption>`,
			"</figure>",
			"</section>",
		);
	}
	sections.push("</div>", "</main>", "</body>", "</html>");
	return `${sections.join("\n")}\n`;
}

export function createImageReviewArtifact(
	targetPath: string,
	options?: {
		title?: string;
		intro?: string;
	},
): {
	reviewPath: string;
	rawHtml: string;
	imagePaths: string[];
} {
	const stats = statSync(targetPath, { throwIfNoEntry: false });
	if (!stats) throw new Error(`Image review target not found: ${targetPath}`);

	let imagePaths: string[];
	if (stats.isDirectory()) {
		imagePaths = collectImageFiles(targetPath);
		if (imagePaths.length === 0) throw new Error(`No supported images found in ${targetPath}`);
	} else if (stats.isFile()) {
		if (!IMAGE_EXTENSIONS.has(extname(targetPath).toLowerCase())) {
			throw new Error(`Image review expects an image file or folder, got: ${targetPath}`);
		}
		imagePaths = [targetPath];
	} else {
		throw new Error(`Image review expects an image file or folder, got: ${targetPath}`);
	}

	mkdirSync(REVIEW_ARTIFACT_DIR, { recursive: true });
	const rawHtml = buildImageReviewHtml(targetPath, imagePaths, options);
	const reviewPath = join(REVIEW_ARTIFACT_DIR, `${basename(targetPath) || "images"}-${randomUUID()}.html`);
	writeFileSync(reviewPath, rawHtml, "utf-8");
	return { reviewPath, rawHtml, imagePaths };
}

async function tryExec(pi: ExtensionAPI, command: string, args: string[]): Promise<ExecResult | undefined> {
	try {
		return await pi.exec(command, args);
	} catch {
		return undefined;
	}
}

async function resolveChromeCommand(pi: ExtensionAPI): Promise<string> {
	for (const candidate of CHROME_CANDIDATES) {
		if (candidate.startsWith("/")) {
			const stats = statSync(candidate, { throwIfNoEntry: false });
			if (stats?.isFile()) return candidate;
			continue;
		}
		const result = await tryExec(pi, candidate, ["--version"]);
		if (result?.exitCode === 0) return candidate;
	}
	throw new Error("Chrome/Chromium not found. Expected one of: google-chrome, chromium, chromium-browser");
}

async function captureHtmlScreenshots(
	pi: ExtensionAPI,
	htmlPath: string,
): Promise<{ screenshotDir: string; screenshotPaths: string[] }> {
	const chrome = await resolveChromeCommand(pi);
	const screenshotDir = join(REVIEW_ARTIFACT_DIR, `html-screens-${randomUUID()}`);
	mkdirSync(screenshotDir, { recursive: true });
	const targetUrl = `file://${htmlPath}`;
	const screenshotPaths: string[] = [];

	for (const viewport of HTML_SCREENSHOT_VIEWPORTS) {
		const outputPath = join(screenshotDir, `${viewport.name}.png`);
		let result = await captureScreenshotWithArgs(pi, chrome, outputPath, targetUrl, viewport, "--headless=new");
		if (result.exitCode !== 0 && !screenshotExists(outputPath)) {
			result = await captureScreenshotWithArgs(pi, chrome, outputPath, targetUrl, viewport, "--headless");
		}
		if (result.exitCode !== 0 && !screenshotExists(outputPath)) {
			throw new Error(
				`Failed to capture ${viewport.name} screenshot: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
			);
		}
		screenshotPaths.push(outputPath);
	}

	return { screenshotDir, screenshotPaths };
}

async function captureScreenshotWithArgs(
	pi: ExtensionAPI,
	chrome: string,
	outputPath: string,
	targetUrl: string,
	viewport: { width: number; height: number },
	extraHeadlessFlag: string,
): Promise<ExecResult> {
	return pi.exec(chrome, [
		extraHeadlessFlag,
		"--disable-gpu",
		"--hide-scrollbars",
		"--allow-file-access-from-files",
		"--disable-web-security",
		"--no-first-run",
		"--no-default-browser-check",
		`--window-size=${viewport.width},${viewport.height}`,
		`--screenshot=${outputPath}`,
		"--virtual-time-budget=5000",
		targetUrl,
	]);
}

function screenshotExists(outputPath: string): boolean {
	const stats = statSync(outputPath, { throwIfNoEntry: false });
	return Boolean(stats?.isFile() && stats.size > 0);
}

async function openAnnotationReview(
	ctx: ExtensionContext,
	options: {
		filePath: string;
		markdown: string;
		mode: "annotate";
		gate: boolean;
		rawHtml?: string;
		renderHtml?: boolean;
	},
): Promise<AnnotationResult> {
	const session = await startAnnotationSession(
		ctx,
		options.filePath,
		options.markdown,
		options.mode,
		undefined,
		undefined,
		undefined,
		options.gate,
		options.rawHtml,
		options.renderHtml,
	);
	return session.waitForDecision();
}

async function openHtmlScreenshotReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	resolvedPath: string,
): Promise<{
	screenshotDir: string;
	screenshotCount: number;
	screenshotManifestPath: string;
	approved: boolean;
	feedback?: string;
	exit?: boolean;
	savedPath?: string;
}> {
	ctx.ui.notify(`Capturing screenshots for ${resolvedPath}...`, "info");
	const { screenshotDir, screenshotPaths } = await captureHtmlScreenshots(pi, resolvedPath);
	const screenshotReview = createImageReviewArtifact(screenshotDir, {
		title: `HTML screenshot review: ${basename(resolvedPath)}`,
		intro: `Review screenshots captured from ${resolvedPath}. Use annotations to call out rendering, layout, and responsiveness issues.`,
	});
	ctx.ui.notify(`Opening screenshot review for ${resolvedPath}...`, "info");
	const result = await openAnnotationReview(ctx, {
		filePath: screenshotReview.reviewPath,
		markdown: "",
		mode: "annotate",
		gate: true,
		rawHtml: screenshotReview.rawHtml,
		renderHtml: true,
	});
	return {
		screenshotDir,
		screenshotCount: screenshotPaths.length,
		screenshotManifestPath: screenshotReview.reviewPath,
		approved: Boolean(result.approved),
		feedback: result.feedback,
		exit: result.exit,
		savedPath: result.savedPath,
	};
}

async function handleHtmlReview(pi: ExtensionAPI, ctx: ExtensionContext, target: string): Promise<TextResult> {
	ensureUiAvailable(ctx);
	const resolvedPath = resolveHtmlReviewTarget(target, ctx.cwd);
	const sourceHtml = readFileSync(resolvedPath, "utf-8");
	ctx.ui.notify(`Opening HTML review for ${resolvedPath}...`, "info");
	const primaryReview = await openAnnotationReview(ctx, {
		filePath: resolvedPath,
		markdown: "",
		mode: "annotate",
		gate: true,
		rawHtml: sourceHtml,
		renderHtml: true,
	});
	const wantsScreenshotReview = await ctx.ui.confirm(
		"Also review screenshots?",
		`HTML review completed for ${resolvedPath}.\n\nOpen an additional screenshot review with desktop and mobile captures?`,
	);
	const screenshotReview = wantsScreenshotReview ? await openHtmlScreenshotReview(pi, ctx, resolvedPath) : null;

	return textResult(
		screenshotReview
			? `HTML review completed for ${resolvedPath}. Screenshot review also completed.`
			: `HTML review completed for ${resolvedPath}.`,
		{
			targetPath: resolvedPath,
			reviewKind: "html",
			renderMode: "direct-html",
			approved: Boolean(primaryReview.approved),
			feedback: primaryReview.feedback,
			exit: primaryReview.exit,
			savedPath: primaryReview.savedPath,
			screenshotReviewOffered: true,
			screenshotReviewAccepted: wantsScreenshotReview,
			screenshotReview,
		},
	);
}

async function handleImageReview(ctx: ExtensionContext, targetPath: string): Promise<TextResult> {
	ensureUiAvailable(ctx);
	const resolvedTarget = resolve(ctx.cwd, targetPath.trim());
	const { reviewPath, rawHtml, imagePaths } = createImageReviewArtifact(resolvedTarget);
	ctx.ui.notify(`Opening image review for ${resolvedTarget}...`, "info");
	const result = await openAnnotationReview(ctx, {
		filePath: reviewPath,
		markdown: "",
		mode: "annotate",
		gate: true,
		rawHtml,
		renderHtml: true,
	});

	return textResult(`Image review completed for ${resolvedTarget}.`, {
		targetPath: resolvedTarget,
		manifestPath: reviewPath,
		imageCount: imagePaths.length,
		reviewKind: "images",
		approved: Boolean(result.approved),
		feedback: result.feedback,
		exit: result.exit,
		savedPath: result.savedPath,
	});
}

export function setStartAnnotationSessionForTests(starter: AnnotationSessionStarter): void {
	startAnnotationSession = starter;
}

export function resetStartAnnotationSessionForTests(): void {
	startAnnotationSession = startMarkdownAnnotationSession;
}

export default function reviewArtifactsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("review-html", {
		description: "Open a local HTML file in Plannotator, then optionally review desktop/mobile screenshots",
		handler: async (args, ctx) => {
			try {
				const result = await handleHtmlReview(pi, ctx, args ?? "");
				ctx.ui.notify(result.content[0].text, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("review-images", {
		description: "Open an image file or folder of images in Plannotator via a generated review gallery",
		handler: async (args, ctx) => {
			try {
				const result = await handleImageReview(ctx, args ?? "");
				ctx.ui.notify(result.content[0].text, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		...commonTool(),
		name: "review_html",
		label: "Review HTML",
		description: "Open a local HTML file in Plannotator, then optionally review desktop/mobile screenshots.",
		parameters: Type.Object({
			targetPath: Type.String({ description: "Local .html or .htm file to review" }),
		}),
		async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
			return handleHtmlReview(pi, ctx, String(params.targetPath ?? ""));
		},
	});

	pi.registerTool({
		...commonTool(),
		name: "review_images",
		label: "Review Images",
		description: "Generate a review gallery for an image file or folder and open it in Plannotator.",
		parameters: Type.Object({
			targetPath: Type.Optional(Type.String({ description: "Image file or folder to review" })),
			folderPath: Type.Optional(Type.String({ description: "Deprecated alias for targetPath" })),
		}),
		async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
			return handleImageReview(ctx, String(params.targetPath ?? params.folderPath ?? ""));
		},
	});
}
