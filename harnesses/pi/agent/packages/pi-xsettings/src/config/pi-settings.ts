import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { settingPath, type SettingDefinition, type SettingOption, type SettingValue } from "../protocol/settings.ts";
import { getPath, type SettingsRecord } from "./store.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

function getJsonPath(document: JsonObject, path: readonly string[]): JsonValue | undefined {
	let current: JsonValue = document;
	for (const segment of path) {
		if (!isJsonObject(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function setJsonPath(document: JsonObject, path: readonly string[], value: SettingValue): void {
	if (path.length === 0) return;
	let current = document;
	for (const segment of path.slice(0, -1)) {
		const child = current[segment];
		if (isJsonObject(child)) current = child;
		else {
			const replacement: JsonObject = {};
			current[segment] = replacement;
			current = replacement;
		}
	}
	current[path.at(-1)!] = value;
}

function deleteJsonPath(document: JsonObject, path: readonly string[]): void {
	if (path.length === 0) return;
	const parents: Array<[JsonObject, string]> = [];
	let current = document;
	for (const segment of path.slice(0, -1)) {
		const child = current[segment];
		if (!isJsonObject(child)) return;
		parents.push([current, segment]);
		current = child;
	}
	delete current[path.at(-1)!];
	for (const [parent, key] of parents.reverse()) {
		const child = parent[key];
		if (isJsonObject(child) && Object.keys(child).length === 0) delete parent[key];
		else break;
	}
}

const option = (value: string | number, label: string, description = ""): SettingOption => ({
	value,
	label,
	description,
});
const numbers = (...values: number[]): SettingOption[] => values.map((value) => option(value, String(value)));

const TEMPLATES = [
	{
		key: "theme",
		label: "Theme",
		description: "Color theme used by Pi.",
		category: "appearance",
		section: "Style",
		apply: "live",
		type: "enum",
		default: "dark",
		options: [],
	},
	{
		key: "quietStartup",
		label: "Quiet startup",
		description: "Hide the startup header.",
		category: "appearance",
		page: "ux",
		section: "Transcript",
		type: "boolean",
		default: false,
	},
	{
		key: "hideThinkingBlock",
		label: "Hide thinking",
		description: "Hide thinking blocks in the transcript.",
		category: "appearance",
		page: "ux",
		section: "Transcript",
		type: "boolean",
		default: false,
	},
	{
		key: "showCacheMissNotices",
		label: "Cache miss notices",
		description: "Show significant prompt-cache misses.",
		category: "appearance",
		page: "ux",
		section: "Transcript",
		type: "boolean",
		default: false,
	},
	{
		key: "collapseChangelog",
		label: "Compact changelog",
		description: "Condense changelog output after updates.",
		category: "appearance",
		page: "ux",
		section: "Transcript",
		type: "boolean",
		default: false,
	},
	{
		key: "editorPaddingX",
		label: "Editor padding",
		description: "Horizontal editor padding.",
		category: "appearance",
		section: "Layout",
		type: "enum",
		default: 0,
		options: numbers(0, 1, 2, 3),
	},
	{
		key: "outputPad",
		label: "Output padding",
		description: "Horizontal transcript padding.",
		category: "appearance",
		section: "Layout",
		type: "enum",
		default: 1,
		options: numbers(0, 1),
	},
	{
		key: "autocompleteMaxVisible",
		label: "Autocomplete rows",
		description: "Maximum visible autocomplete results.",
		category: "appearance",
		section: "Layout",
		type: "enum",
		default: 5,
		options: numbers(3, 5, 8, 10, 15, 20),
	},
	{
		key: "showHardwareCursor",
		label: "Hardware cursor",
		description: "Show the terminal cursor for IME positioning.",
		category: "appearance",
		page: "terminal",
		section: "Cursor",
		type: "boolean",
		default: false,
	},
	{
		key: "tuiMode",
		label: "TUI mode",
		description: "Choose regular or fullscreen rendering.",
		category: "appearance",
		page: "terminal",
		section: "Fullscreen",
		type: "enum",
		default: "regular",
		options: [option("regular", "Regular"), option("fullscreen", "Fullscreen")],
	},
	{
		key: "fullscreenExitOutput",
		label: "Fullscreen exit",
		description: "Output left after fullscreen Pi exits.",
		category: "appearance",
		page: "terminal",
		section: "Fullscreen",
		type: "enum",
		default: "transcript",
		options: [option("transcript", "Transcript"), option("resume-hint", "Resume hint")],
	},
	{
		key: "fullscreenScrollbar",
		label: "Fullscreen scrollbar",
		description: "Scrollbar behavior in fullscreen mode.",
		category: "appearance",
		page: "terminal",
		section: "Fullscreen",
		type: "enum",
		default: "auto",
		options: [option("auto", "Automatic"), option("always", "Always"), option("hidden", "Hidden")],
	},
	{
		key: "markdown.codeBlockIndent",
		label: "Code block indent",
		description: "Indent used for rendered fenced code.",
		category: "appearance",
		section: "Markdown",
		type: "enum",
		default: "  ",
		options: [option("", "None"), option("  ", "Two spaces"), option("    ", "Four spaces")],
	},
	{
		key: "markdown.mermaid",
		label: "Mermaid",
		description: "When Mermaid diagrams render.",
		category: "appearance",
		section: "Markdown",
		type: "enum",
		default: "streaming",
		options: [option("off", "Off"), option("final", "Final"), option("streaming", "Streaming")],
	},
	{
		key: "terminal.showImages",
		label: "Terminal images",
		description: "Show images in supported terminals.",
		category: "appearance",
		page: "terminal",
		section: "Images",
		type: "boolean",
		default: true,
	},
	{
		key: "terminal.imageWidthCells",
		label: "Image width",
		description: "Preferred inline image width in cells.",
		category: "appearance",
		page: "terminal",
		section: "Images",
		type: "enum",
		default: 60,
		options: numbers(30, 45, 60, 80, 100),
	},
	{
		key: "terminal.clearOnShrink",
		label: "Clear on shrink",
		description: "Clear rows when rendered content becomes shorter.",
		category: "appearance",
		page: "terminal",
		section: "Images",
		type: "boolean",
		default: false,
	},
	{
		key: "terminal.showTerminalProgress",
		label: "Terminal progress",
		description: "Use terminal-native progress reporting when available.",
		category: "appearance",
		page: "terminal",
		section: "Images",
		type: "boolean",
		default: false,
	},
	{
		key: "images.autoResize",
		label: "Resize images",
		description: "Resize large images before sending them.",
		category: "appearance",
		page: "terminal",
		section: "Images",
		type: "boolean",
		default: true,
	},
	{
		key: "images.blockImages",
		label: "Block images",
		description: "Prevent images from reaching the model.",
		category: "appearance",
		page: "terminal",
		section: "Images",
		type: "boolean",
		default: false,
	},
	{
		key: "compaction.enabled",
		label: "Auto compaction",
		description: "Compact automatically near the context limit.",
		category: "behavior",
		section: "Compaction",
		type: "boolean",
		default: true,
	},
	{
		key: "compaction.reserveTokens",
		label: "Response reserve",
		description: "Tokens reserved for the next response.",
		category: "behavior",
		section: "Compaction",
		type: "enum",
		default: 16384,
		options: numbers(8192, 16384, 32768, 65536),
	},
	{
		key: "compaction.keepRecentTokens",
		label: "Recent tokens",
		description: "Recent tokens kept outside the summary.",
		category: "behavior",
		section: "Compaction",
		type: "enum",
		default: 20000,
		options: numbers(10000, 20000, 40000, 80000),
	},
	{
		key: "branchSummary.reserveTokens",
		label: "Branch reserve",
		description: "Tokens reserved for branch summaries.",
		category: "behavior",
		section: "Branch Summary",
		type: "enum",
		default: 16384,
		options: numbers(8192, 16384, 32768),
	},
	{
		key: "branchSummary.skipPrompt",
		label: "Skip branch prompt",
		description: "Navigate without asking to summarize.",
		category: "behavior",
		section: "Branch Summary",
		type: "boolean",
		default: false,
	},
	{
		key: "retry.enabled",
		label: "Automatic retry",
		description: "Retry transient agent failures.",
		category: "behavior",
		section: "Retry",
		type: "boolean",
		default: true,
	},
	{
		key: "retry.maxRetries",
		label: "Retry attempts",
		description: "Maximum agent retry attempts.",
		category: "behavior",
		section: "Retry",
		type: "enum",
		default: 3,
		options: numbers(0, 1, 2, 3, 5),
	},
	{
		key: "retry.baseDelayMs",
		label: "Retry delay",
		description: "Initial retry backoff in milliseconds.",
		category: "behavior",
		section: "Retry",
		type: "enum",
		default: 2000,
		options: numbers(500, 1000, 2000, 5000, 10000),
	},
	{
		key: "retry.provider.maxRetries",
		label: "Provider retries",
		description: "Provider SDK retry attempts. Keep at zero unless explicitly needed.",
		category: "behavior",
		section: "Retry",
		type: "enum",
		default: 0,
		options: numbers(0, 1, 2, 3),
	},
	{
		key: "retry.provider.maxRetryDelayMs",
		label: "Provider retry delay",
		description: "Maximum server-requested retry delay in milliseconds.",
		category: "behavior",
		section: "Retry",
		type: "enum",
		default: 60000,
		options: numbers(0, 10000, 30000, 60000, 120000),
	},
	{
		key: "enabledModels",
		label: "Model cycle",
		description: "Ordered model patterns used for model cycling.",
		category: "behavior",
		section: "Model Cycling",
		type: "multi-enum",
		default: [],
		options: [],
		ordered: true,
	},
	{
		key: "steeringMode",
		label: "Steering delivery",
		description: "How queued steering messages are delivered.",
		category: "interaction",
		section: "Message Delivery",
		type: "enum",
		default: "one-at-a-time",
		options: [option("one-at-a-time", "One at a time"), option("all", "All")],
	},
	{
		key: "followUpMode",
		label: "Follow-up delivery",
		description: "How queued follow-up messages are delivered.",
		category: "interaction",
		section: "Message Delivery",
		type: "enum",
		default: "one-at-a-time",
		options: [option("one-at-a-time", "One at a time"), option("all", "All")],
	},
	{
		key: "transport",
		label: "Transport",
		description: "Preferred provider transport.",
		category: "interaction",
		section: "Message Delivery",
		type: "enum",
		default: "auto",
		options: [
			option("auto", "Automatic"),
			option("sse", "SSE"),
			option("websocket", "WebSocket"),
			option("websocket-cached", "Cached WebSocket"),
		],
	},
	{
		key: "httpIdleTimeoutMs",
		label: "HTTP idle timeout",
		description: "Header and body idle timeout in milliseconds.",
		category: "interaction",
		section: "Message Delivery",
		type: "enum",
		default: 300000,
		options: numbers(0, 60000, 300000, 600000),
	},
	{
		key: "websocketConnectTimeoutMs",
		label: "WebSocket timeout",
		description: "WebSocket connection timeout in milliseconds.",
		category: "interaction",
		section: "Message Delivery",
		type: "enum",
		default: 15000,
		options: numbers(0, 5000, 15000, 30000, 60000),
	},
	{
		key: "defaultTools",
		label: "Built-in tools",
		description: "Built-in tools enabled when Pi starts.",
		category: "tools",
		section: "Tools",
		type: "multi-enum",
		default: [],
		options: [],
		ordered: false,
	},
] satisfies readonly SettingDefinition[];

function stringOptions(values: readonly string[]): SettingOption[] {
	return values.map((value) => option(value, value));
}

export function piSettingDefinitions(
	pi: Pick<ExtensionAPI, "getAllTools">,
	ctx: ExtensionContext,
): SettingDefinition[] {
	const modelOptions = stringOptions(
		(ctx.scopedModels.length > 0
			? ctx.scopedModels.map(({ model }) => `${model.provider}/${model.id}`)
			: ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`)
		)
			.filter((value, index, all) => all.indexOf(value) === index)
			.sort(),
	);
	const toolOptions = stringOptions(
		pi
			.getAllTools()
			.filter((tool) => tool.sourceInfo.source === "builtin")
			.map((tool) => tool.name)
			.sort(),
	);
	const themes = stringOptions(
		ctx.ui
			.getAllThemes()
			.map(({ name }) => name)
			.sort(),
	);
	return TEMPLATES.map((template): SettingDefinition => {
		if (template.type === "enum" && template.key === "theme") return { ...template, options: themes };
		if (template.type === "multi-enum" && template.key === "enabledModels")
			return { ...template, options: modelOptions };
		if (template.type === "multi-enum" && template.key === "defaultTools") return { ...template, options: toolOptions };
		return template;
	});
}

function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configuredPiValues(document: SettingsRecord): Record<string, SettingValue> {
	const result: Record<string, SettingValue> = {};
	for (const definition of TEMPLATES) {
		const value = getPath(document, settingPath(definition));
		if (typeof value === "boolean" || typeof value === "number" || typeof value === "string")
			result[definition.key] = value;
		else if (Array.isArray(value) && value.every((item) => typeof item === "string")) result[definition.key] = value;
	}
	return result;
}

export async function syncPiSettingsJson(
	values: Readonly<Record<string, SettingValue>>,
	agentDir = getAgentDir(),
): Promise<boolean> {
	const path = join(agentDir, "settings.json");
	let target = path;
	let source = "{}";
	try {
		target = await realpath(path);
		source = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const parsed = JSON.parse(source) as JsonValue;
	if (!isJsonObject(parsed)) throw new Error(`${path} must contain a JSON object`);
	let changed = false;
	for (const definition of TEMPLATES) {
		if (definition.key in values || getJsonPath(parsed, definition.key.split(".")) === undefined) continue;
		deleteJsonPath(parsed, definition.key.split("."));
		changed = true;
	}
	for (const [key, value] of Object.entries(values)) {
		const segments = key.split(".");
		if (JSON.stringify(getJsonPath(parsed, segments)) === JSON.stringify(value)) continue;
		setJsonPath(parsed, segments, value);
		changed = true;
	}
	if (!changed) return false;
	await mkdir(dirname(target), { recursive: true });
	let mode = 0o600;
	try {
		mode = (await stat(target)).mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode });
	await rename(temporary, target);
	return true;
}
