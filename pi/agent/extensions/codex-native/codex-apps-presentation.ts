import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, Spacer, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { KittyVirtualImage } from "../shared/kitty-virtual-image";
import { defineExtensionTui, textComponent, truncateToWidthCompat } from "../shared/tui";
import { AgentSettingsPanel, type AgentSettingsTab } from "./agent-settings-view.ts";
import { codexAppTextContentToText, humanizeIdentifier } from "./codex-app-content.ts";

const codexAppsTui = defineExtensionTui({ id: "agent-settings" });

export interface CodexAppPresentationTool {
	title: string;
	mcpToolName: string;
	connectorName: string;
}

export interface CodexAppRenderContext {
	isError?: boolean;
	isPartial?: boolean;
	lastComponent?: unknown;
	toolCallId?: string;
}

export interface CodexAppRenderResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

export function codexAppRenderers(tool: CodexAppPresentationTool) {
	return {
		renderShell: "self" as const,
		renderCall(args: Record<string, unknown>, theme: Theme, context: CodexAppRenderContext) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : textComponent("");
			text.setText(renderCodexAppCall(tool, args, theme, context.isPartial !== false, context.isError === true));
			return text;
		},
		renderResult(
			result: CodexAppRenderResult,
			{ expanded }: { expanded?: boolean },
			theme: Theme,
			context: CodexAppRenderContext,
		) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : textComponent("");
			if (context.isPartial) return text;
			const details = codexAppTextContentToText(
				result.content.find((item) => item.type === "text")?.text ?? "",
			).trim();
			const images = result.content.filter(
				(item): item is ImageContent => item.type === "image" && Boolean(item.data && item.mimeType),
			);
			if (images.length > 0 && getCapabilities().images) {
				const container = new Container();
				if (details) {
					text.setText(renderCodexAppResult(details, theme, expanded));
					container.addChild(text);
					container.addChild(new Spacer(1));
				}
				for (const [index, image] of images.entries()) {
					if (index > 0) container.addChild(new Spacer(1));
					container.addChild(
						new KittyVirtualImage(
							image.data,
							image.mimeType,
							{ fallbackColor: (fallback) => theme.fg("toolOutput", fallback) },
							{ maxWidthCells: 80, maxHeightCells: 30 },
						),
					);
				}
				return container;
			}
			if (!details) return new Container();
			text.setText(renderCodexAppResult(details, theme, expanded));
			return text;
		},
	};
}

function renderCodexAppCall(
	tool: CodexAppPresentationTool,
	args: Record<string, unknown>,
	theme: Theme,
	running: boolean,
	failed: boolean,
): string {
	const status = theme.fg(running ? "dim" : failed ? "error" : "success", "•");
	const verb = running ? "Using" : "Used";
	const action = codexAppActionLabel(tool);
	const summary = summarizeCodexAppArgs(args);
	const suffix = summary ? `${theme.fg("dim", " · ")}${theme.fg("muted", summary)}` : "";
	return `${status} ${theme.bold(verb)} ${renderConnectorName(tool.connectorName, theme)} ${theme.fg("accent", action)}${suffix}`;
}

function renderConnectorName(connectorName: string, theme: Theme): string {
	if (connectorName.toLowerCase() !== "slack") return connectorName;
	return theme.bold(
		`${theme.fg("warning", " ")}${theme.fg("mdLink", "S")}${theme.fg("success", "l")}${theme.fg("warning", "a")}${theme.fg("error", "c")}${theme.fg("toolTitle", "k")}`,
	);
}

function renderCodexAppResult(text: string, theme: Theme, expanded: boolean | undefined): string {
	const lines =
		expanded || text.split("\n").length <= 8
			? text.split("\n")
			: [...text.split("\n").slice(0, 4), `… +${text.split("\n").length - 7} lines`, ...text.split("\n").slice(-3)];
	return lines
		.flatMap((line) => wrapTextWithAnsi(line, 120))
		.map((line, index, allLines) => {
			const prefix = index === allLines.length - 1 ? "  └ " : index === 0 ? "  ├ " : "  │ ";
			return `${theme.fg("dim", prefix)}${theme.fg("dim", truncateToWidthCompat(line || " ", 120, "…"))}`;
		})
		.join("\n");
}

function codexAppActionLabel(tool: CodexAppPresentationTool): string {
	const connectorPrefix = tool.connectorName
		.normalize("NFKD")
		.replace(/[^a-zA-Z0-9_]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 56)
		.toLowerCase();
	let title = tool.title || tool.mcpToolName;
	const lower = title.toLowerCase();
	if (lower.startsWith(`${connectorPrefix}_`)) title = title.slice(connectorPrefix.length + 1);
	if (lower.startsWith(`${connectorPrefix} `)) title = title.slice(connectorPrefix.length + 1);
	return humanizeIdentifier(title);
}

function summarizeCodexAppArgs(args: Record<string, unknown>): string {
	const preferred = [
		"channel_id",
		"message_ts",
		"query",
		"repo_full_name",
		"pr_number",
		"issue_number",
		"path",
		"ref",
		"id",
	];
	const parts: string[] = [];
	for (const key of preferred) {
		if (key in args) parts.push(formatArgValue(key, args[key]));
		if (parts.length >= 3) break;
	}
	if (parts.length === 0) {
		for (const [key, value] of Object.entries(args)) {
			if (parts.length >= 3) break;
			if (value === undefined || value === null || typeof value === "object") continue;
			parts.push(formatArgValue(key, value));
		}
	}
	return parts.filter(Boolean).join(" ");
}

function formatArgValue(key: string, value: unknown): string {
	if (value === undefined || value === null) return "";
	const label = key.endsWith("_id") ? "" : `${humanizeIdentifier(key)} `;
	const raw = typeof value === "string" ? value : String(value);
	return `${label}${truncateToWidthCompat(raw.replace(/\s+/g, " "), 80, "…")}`.trim();
}

export function showCodexAppsStatus(ctx: ExtensionContext, status: string): void {
	codexAppsTui.bind(ctx).status.set("status", ctx.ui.theme.fg("dim", status));
}

export async function showAgentSettingsPanel(
	ctx: ExtensionContext,
	tabs: readonly AgentSettingsTab[],
	onSaveError: (error: unknown) => void,
): Promise<void> {
	let panel: AgentSettingsPanel | undefined;
	await codexAppsTui.bind(ctx).overlays.openComponent<undefined>(
		(tui, theme: Theme, _keybindings, done) => {
			panel = new AgentSettingsPanel(
				theme,
				tabs,
				() => tui.requestRender(),
				() => done(undefined),
				onSaveError,
			);
			return panel;
		},
		{ overlayOptions: { width: "90%", maxHeight: 32, margin: 1 } },
	);
	await panel?.waitForPendingActions();
}
