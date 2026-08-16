import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { fuzzyFilter, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { getRegisteredTool, type RegisteredToolDefinition } from "../shared/tool-registry.ts";
import { defineExtensionTui, faint as dim, italic, truncateToWidthCompat } from "../shared/tui";
import { AGENT_TOOL_NAMES } from "../subagents/tool-names.ts";
import type { BasePromptTraceResult, TraceBucket, TraceLineEvidence } from "./base-trace/index.js";
import { TOOL_REACH_ORDER, toolReachDescription, toolReachLabel } from "./tool-reach.ts";
import type {
	ParsedPrompt,
	SessionUsageData,
	SkillInfo,
	SkillToggleResult,
	TableItem,
	ToolEntry,
	ToolSectionData,
} from "./types.js";
import { DisableMode, ToolReach } from "./types.js";
import { formatCost } from "./usage.ts";
import { buildBarSegments } from "./utils.js";

const tokenBurdenTui = defineExtensionTui({ id: "token-burden" });
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_VISIBLE_ROWS = 8;
const OVERLAY_WIDTH = 80;

/** ANSI SGR codes for section bar colors. */
const SECTION_COLORS = [
	"38;2;23;143;185", // blue — Base prompt
	"38;2;137;210;129", // green — AGENTS.md
	"38;2;254;188;56", // orange — Skills
	"38;2;178;129;214", // purple — extra sections
	"2", // dim — Metadata (always last)
];

const SESSION_COLORS = {
	prompt: "38;2;243;139;168",
	assistant: "38;2;137;220;235",
	thinking: "38;2;203;166;247",
	tools: "38;2;249;226;175",
} as const;

const SESSION_COLOR_PALETTE = [
	SESSION_COLORS.prompt,
	SESSION_COLORS.assistant,
	SESSION_COLORS.thinking,
	SESSION_COLORS.tools,
	"38;2;166;227;161",
	"38;2;250;179;135",
	"38;2;180;190;254",
	"38;2;137;180;250",
];

/** Rainbow dot colors for scroll indicator. */
const RAINBOW = [
	"38;2;178;129;214",
	"38;2;215;135;175",
	"38;2;254;188;56",
	"38;2;228;192;15",
	"38;2;137;210;129",
	"38;2;0;175;175",
	"38;2;23;143;185",
];

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

function sgr(code: string, text: string): string {
	if (!code) {
		return text;
	}
	return `\u001B[${code}m${text}\u001B[0m`;
}

function bold(text: string): string {
	return `\u001B[1m${text}\u001B[22m`;
}

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

function rainbowDots(filled: number, total: number): string {
	const dots: string[] = [];
	for (let i = 0; i < total; i++) {
		const color = RAINBOW[i % RAINBOW.length];
		dots.push(sgr(color, i < filled ? "●" : "○"));
	}
	return dots.join(" ");
}

function shortenLabel(label: string): string {
	if (label.startsWith("Tool schemas")) {
		return "Tool defs";
	}
	if (label.startsWith("Session floor")) {
		return "Floor";
	}
	if (label.startsWith("Since compaction")) {
		return "Compacted";
	}
	if (label.startsWith("Tool result:")) {
		const toolLabel = label.slice("Tool result:".length).trim();
		const execMatch = toolLabel.match(/^exec_command\((.*)\)$/);
		if (execMatch?.[1]) {
			return truncateToWidthCompat(`exec:${execMatch[1]}`, 18, "…");
		}
		return truncateToWidthCompat(toolLabel, 18, "…");
	}
	if (label.startsWith("User")) {
		return "User";
	}
	if (label.startsWith("Assistant")) {
		return "Assistant";
	}
	if (label.startsWith("Thinking")) {
		return "Thinking";
	}
	if (label.startsWith("AGENTS")) {
		return "AGENTS";
	}
	if (label.startsWith("Skills")) {
		return "Skills";
	}
	if (label.startsWith("Metadata")) {
		return "Meta";
	}
	if (label.startsWith("Base")) {
		return "Base";
	}
	if (label.startsWith("SYSTEM")) {
		return "SYSTEM";
	}
	if (label.startsWith("Tool")) {
		return "Tools";
	}
	return truncateToWidthCompat(label, 10, "…");
}

/** Resolve the user's preferred editor: $VISUAL → $EDITOR → vi. */
function getEditor(): string {
	return process.env.VISUAL || process.env.EDITOR || "vi";
}

/** True for sections whose content is generated (not a user-editable file). */
function isReadOnlySection(label: string): boolean {
	return label.startsWith("Base") || label.startsWith("Metadata") || label.startsWith("SYSTEM");
}

/** Convert a section label to a safe filename slug. */
function sanitizeLabel(label: string): string {
	return label
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-|-$/g, "");
}

export function isBackKey(data: string): boolean {
	return matchesKey(data, "escape") || data === "h" || data === "q";
}

function isCloseKey(data: string): boolean {
	return matchesKey(data, "escape") || data === "q";
}

export function isNavigateUpKey(data: string): boolean {
	return matchesKey(data, "up") || data === "k";
}

export function isNavigateDownKey(data: string): boolean {
	return matchesKey(data, "down") || data === "j";
}

export function isForwardKey(data: string): boolean {
	return matchesKey(data, "enter") || data === "l";
}

function isToggleKey(data: string): boolean {
	return isForwardKey(data) || data === " ";
}

// ---------------------------------------------------------------------------
// Data preparation
// ---------------------------------------------------------------------------

/** Convert ParsedPrompt sections into TableItems sorted by tokens desc. */
function buildTableItems(parsed: ParsedPrompt): TableItem[] {
	return parsed.sections
		.map((section): TableItem => {
			const pct = parsed.totalTokens > 0 ? (section.tokens / parsed.totalTokens) * 100 : 0;

			const children: TableItem[] | undefined = section.children?.length
				? section.children
						.map(
							(child): TableItem => ({
								label: child.label,
								tokens: child.tokens,
								chars: child.chars,
								pct: parsed.totalTokens > 0 ? (child.tokens / parsed.totalTokens) * 100 : 0,
								drillable: false,
								content: child.content,
							}),
						)
						.toSorted((a, b) => b.tokens - a.tokens)
				: undefined;

			return {
				label: section.label,
				tokens: section.tokens,
				chars: section.chars,
				pct,
				drillable: (children?.length ?? 0) > 0 || Boolean(section.tools),
				content: section.content,
				tools: section.tools,
				children,
			};
		})
		.toSorted((a, b) => b.tokens - a.tokens);
}

// ---------------------------------------------------------------------------
// Row rendering helpers
// ---------------------------------------------------------------------------

function makeRow(innerW: number): (content: string) => string {
	return (content: string): string =>
		`${dim("│")}${truncateToWidthCompat(` ${content}`, innerW, "…", true)}${dim("│")}`;
}

function makeEmptyRow(innerW: number): () => string {
	return (): string => `${dim("│")}${" ".repeat(innerW)}${dim("│")}`;
}

function makeDivider(innerW: number): () => string {
	return (): string => dim(`├${"─".repeat(innerW)}┤`);
}

function makeCenterRow(innerW: number): (content: string) => string {
	return (content: string): string => {
		const vis = visibleWidth(content);
		const padding = Math.max(0, innerW - vis);
		const left = Math.floor(padding / 2);
		return `${dim("│")}${" ".repeat(left)}${content}${" ".repeat(padding - left)}${dim("│")}`;
	};
}

// ---------------------------------------------------------------------------
// Zone renderers
// ---------------------------------------------------------------------------

function renderTitleBorder(innerW: number): string {
	const titleText = " Token Burden ";
	const borderLen = innerW - visibleWidth(titleText);
	const leftBorder = Math.floor(borderLen / 2);
	const rightBorder = borderLen - leftBorder;
	return dim(`╭${"─".repeat(leftBorder)}${titleText}${"─".repeat(rightBorder)}╮`);
}

/**
 * The headline, and the one number on this screen that is not a model of
 * anything: the last request's prompt, as the provider counted it.
 *
 * Before the first reply there is no usage to read, so the estimated system
 * prompt stands in — marked, because an estimate wearing the headline's
 * clothes is the thing this view exists to stop.
 */
function renderContextWindowBar(
	lines: string[],
	parsed: ParsedPrompt,
	contextWindow: number,
	sessionUsage: SessionUsageData | undefined,
	innerW: number,
	row: (content: string) => string,
	emptyRow: () => string,
	divider: () => string,
): void {
	const measured = sessionUsage && sessionUsage.tokens > 0 ? sessionUsage : undefined;
	const tokens = measured ? measured.tokens : parsed.totalTokens;
	const pct = (tokens / contextWindow) * 100;
	const prefix = measured ? "" : "~";
	const source = measured ? dim("measured") : dim(italic("estimated"));
	const label = `${prefix}${fmt(tokens)} / ${fmt(contextWindow)} tokens (${pct.toFixed(1)}%)`;
	const gap = Math.max(1, innerW - visibleWidth(label) - visibleWidth(source) - 2);
	lines.push(row(`${label}${" ".repeat(gap)}${source}`));

	const barWidth = innerW - 4;
	const filled = Math.max(1, Math.round((pct / 100) * barWidth));
	const empty = Math.max(0, barWidth - filled);
	lines.push(row(`${sgr("36", "█".repeat(filled))}${dim("░".repeat(empty))}`));

	if (measured) {
		const totals = measured.totals;
		lines.push(
			row(
				dim(
					[
						`floor ${fmt(totals.floorTokens)}`,
						`${(totals.cachedShare * 100).toFixed(0)}% cached`,
						`${fmt(totals.turns)} turn${totals.turns === 1 ? "" : "s"}`,
						formatCost(totals.cost),
					].join("  ·  "),
				),
			),
		);
	}

	lines.push(emptyRow());
	lines.push(divider());
	lines.push(emptyRow());
}

interface BarCategory {
	label: string;
	tokens: number;
	color: string;
}

function renderStackedBar(
	lines: string[],
	parsed: ParsedPrompt,
	innerW: number,
	row: (content: string) => string,
): void {
	lines.push(row(dim(`System prompt — ${italic(`estimated ~${fmt(parsed.totalTokens)}`)}`)));
	renderStackedCategories(lines, burdenCategories(parsed), parsed.totalTokens, innerW, row);
}

function burdenCategories(parsed: ParsedPrompt): BarCategory[] {
	return parsed.sections.map((section, index) => ({
		label: section.label,
		tokens: section.tokens,
		color: SECTION_COLORS[Math.min(index, SECTION_COLORS.length - 1)] ?? "2",
	}));
}

function sessionCategoryColor(label: string): string {
	if (label.startsWith("Assistant")) {
		return SESSION_COLORS.assistant;
	}
	if (label.startsWith("Thinking")) {
		return SESSION_COLORS.thinking;
	}
	if (label.startsWith("Tool")) {
		return SESSION_COLORS.tools;
	}
	return SESSION_COLORS.prompt;
}

function distinctSessionCategoryColor(label: string, index: number, previousColor: string | undefined): string {
	const preferred = sessionCategoryColor(label);
	if (index === 0 && preferred !== previousColor) {
		return preferred;
	}

	const preferredIndex = SESSION_COLOR_PALETTE.indexOf(preferred);
	const startIndex = preferredIndex === -1 ? index : preferredIndex + index;
	for (let offset = 0; offset < SESSION_COLOR_PALETTE.length; offset++) {
		const color = SESSION_COLOR_PALETTE[(startIndex + offset) % SESSION_COLOR_PALETTE.length];
		if (color !== previousColor) {
			return color;
		}
	}

	return preferred;
}

/**
 * The measured context, split.
 *
 * The floor leads rather than sorting into place: it is the exact half of this
 * bar and usually the largest single piece, and putting it first keeps the two
 * kinds of number from being read as one ranked list.
 */
function contextCategories(sessionUsage: SessionUsageData): BarCategory[] {
	const floor = sessionUsage.categories.filter((category) => !category.estimated);
	const growth = sessionUsage.categories.filter((category) => category.estimated);
	const categories: BarCategory[] = floor.map((category, index) => ({
		label: category.label,
		tokens: category.tokens,
		color: SECTION_COLORS[Math.min(index, SECTION_COLORS.length - 1)] ?? "2",
	}));

	let previousColor = categories.at(-1)?.color;
	for (const [index, category] of growth.toSorted((left, right) => right.tokens - left.tokens).entries()) {
		const color = distinctSessionCategoryColor(category.label, index, previousColor);
		categories.push({ label: category.label, tokens: category.tokens, color });
		previousColor = color;
	}

	return categories.filter((category) => category.tokens > 0);
}

function renderStackedCategories(
	lines: string[],
	categories: BarCategory[],
	totalTokens: number,
	innerW: number,
	row: (content: string) => string,
): void {
	const barWidth = innerW - 4;
	const segments = buildBarSegments(
		categories.map((category) => ({ label: category.label, tokens: category.tokens })),
		barWidth,
	);

	// Stacked bar
	let bar = "";
	for (let i = 0; i < segments.length; i++) {
		const category = categories[i];
		bar += sgr(category?.color ?? "2", "█".repeat(segments[i].width));
	}
	lines.push(row(bar));

	// Legend
	const legendParts: string[] = [];
	for (let i = 0; i < segments.length; i++) {
		const category = categories[i];
		if (!category) {
			continue;
		}
		const pct = totalTokens > 0 ? ((category.tokens / totalTokens) * 100).toFixed(1) : "0.0";
		const shortLabel = shortenLabel(category.label);
		legendParts.push(`${sgr(category.color, "■")} ${shortLabel} ${pct}%`);
	}
	for (const legendLine of wrapLegendParts(legendParts, innerW - 1)) {
		lines.push(row(legendLine));
	}
}

function renderContextStackedBar(
	lines: string[],
	sessionUsage: SessionUsageData,
	innerW: number,
	row: (content: string) => string,
): void {
	lines.push(row(dim(`Context by category — floor measured, ${italic("growth split estimated")}`)));
	renderStackedCategories(lines, contextCategories(sessionUsage), sessionUsage.tokens, innerW, row);
}

export function wrapLegendParts(parts: string[], maxWidth: number): string[] {
	const rows: string[] = [];
	let current = "";

	for (const part of parts) {
		const candidate = current ? `${current}  ${part}` : part;
		if (current && visibleWidth(candidate) > maxWidth) {
			rows.push(current);
			current = part;
		} else {
			current = candidate;
		}
	}

	if (current) {
		rows.push(current);
	}

	return rows;
}

/**
 * Rows here are all estimates — the provider itemises no part of the prompt —
 * so they all carry the tilde. It is not decoration: the bar above them is
 * measured, and the two must not read as the same kind of number.
 */
function renderTableRow(item: TableItem, isSelected: boolean, innerW: number): string {
	const prefix = isSelected ? sgr("36", "▸") : dim("·");

	const tokenStr = `~${fmt(item.tokens)} tokens`;
	const pctStr = `${item.pct.toFixed(1)}%`;
	const suffix = `${tokenStr}   ${pctStr}`;

	// Calculate available space for name
	const suffixWidth = visibleWidth(suffix);
	const prefixWidth = 2; // "▸ " or "· "
	const gapMin = 2;
	const nameMaxWidth = innerW - prefixWidth - suffixWidth - gapMin - 3;

	const truncatedName = truncateToWidthCompat(
		isSelected ? bold(sgr("36", item.label)) : item.label,
		nameMaxWidth,
		"…",
	);
	const nameWidth = visibleWidth(truncatedName);
	const gap = Math.max(1, innerW - prefixWidth - nameWidth - suffixWidth - 3);

	const content = `${prefix} ${truncatedName}${" ".repeat(gap)}${dim(suffix)}`;

	return `${dim("│")}${truncateToWidthCompat(` ${content}`, innerW, "…", true)}${dim("│")}`;
}

// ---------------------------------------------------------------------------
// BudgetOverlay component
// ---------------------------------------------------------------------------

type Mode = "sections" | "drilldown" | "tools" | "turns" | "skill-toggle" | "trace" | "trace-drilldown";

interface OverlayState {
	mode: Mode;
	selectedIndex: number;
	scrollOffset: number;
	searchActive: boolean;
	searchQuery: string;
	drilldownSection: TableItem | null;
	toolsSection: TableItem | null;
	toolTab: ToolTab;
	toolTabCursor: Map<ToolTab, { selectedIndex: number; scrollOffset: number }>;
	collapsedToolGroups: Set<string>;
	pendingChanges: Map<string, DisableMode>;
	confirmingDiscard: boolean;
	traceResult: BasePromptTraceResult | null;
	traceLoading: boolean;
	traceDrilldownBucket: TraceBucket | null;
}

interface ToolRow {
	kind: "tool";
	label: string;
	toolName: string;
	reach: ToolReach;
	indented?: boolean;
	chars: number;
	tokens: number;
	content: string;
}

interface ToolGroupRow {
	kind: "group";
	label: string;
	groupKey: string;
	reach: ToolReach;
	tools: ToolRow[];
	tokens: number;
	collapsed: boolean;
}

type ToolsRow = ToolRow | ToolGroupRow;

/** Ask tool-policy to move a tool to `reach`. False when the policy refuses. */
export type ToolReachHandler = (toolName: string, reach: ToolReach) => boolean;

/** Glyph and SGR colour per state, in the order the legend reads them. */
const REACH_STYLE: Record<ToolReach, { glyph: string; color: string }> = {
	[ToolReach.Direct]: { glyph: "●", color: "32" },
	[ToolReach.Declared]: { glyph: "◆", color: "36" },
	[ToolReach.Deferred]: { glyph: "○", color: "38;2;137;180;250" },
	[ToolReach.Blocked]: { glyph: "✕", color: "31" },
	[ToolReach.Unreachable]: { glyph: "!", color: "33" },
};

const REACH_CYCLE: readonly ToolReach[] = [ToolReach.Direct, ToolReach.Declared, ToolReach.Deferred, ToolReach.Blocked];

/** The state `space` asks for next. `Unreachable` is off the ring, so it enters at `Direct`. */
export function nextToolReach(reach: ToolReach): ToolReach {
	const index = REACH_CYCLE.indexOf(reach);
	return REACH_CYCLE[(index + 1) % REACH_CYCLE.length] ?? ToolReach.Direct;
}

const TOOL_TABS = ["native", "mcp", "apps"] as const;
type ToolTab = (typeof TOOL_TABS)[number];

const TOOL_TAB_LABELS: Record<ToolTab, string> = { native: "Native", mcp: "MCP", apps: "Apps" };

export function toolTabFor(toolName: string): ToolTab {
	if (toolName.startsWith("mcp__")) {
		return "mcp";
	}
	if (toolName.startsWith("codex_apps_")) {
		return "apps";
	}
	return "native";
}

export function filterToolsByTab(tools: readonly ToolEntry[], tab: ToolTab): ToolEntry[] {
	return tools.filter((tool) => toolTabFor(toolDisplayName(tool)) === tab);
}

function parseToolContent(tool: ToolEntry): unknown {
	try {
		return JSON.parse(typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content)) as unknown;
	} catch {
		return {
			name: typeof tool.name === "string" ? tool.name : undefined,
			content: typeof tool.content === "string" ? tool.content : "",
		};
	}
}

function objectValue(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return (value as Record<string, unknown>)[key];
}

function humanizeIdentifier(value: string): string {
	return value
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

function slugIdentifier(value: string): string {
	return value
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "_")
		.replaceAll(/^_+|_+$/g, "");
}

interface CodexAppToolInfo {
	appLabel: string;
	displayName: string;
}

function toolDisplayName(tool: ToolEntry): string {
	if (typeof tool.name === "string" && tool.name.length > 0) return tool.name;
	const parsed = parseToolContent(tool);
	const parsedName = objectValue(parsed, "name");
	if (typeof parsedName === "string" && parsedName.length > 0) return parsedName;
	return "(unnamed tool)";
}

function codexAppToolInfo(tool: ToolEntry): CodexAppToolInfo | undefined {
	const prefix = "codex_apps_";
	const toolName = toolDisplayName(tool);
	if (!toolName.startsWith(prefix)) {
		return undefined;
	}

	const parsed = parseToolContent(tool);
	const description = objectValue(parsed, "description");
	const descriptionApp =
		typeof description === "string" ? description.match(/(?:^|\n)Codex app:\s*([^\n.]+)\./i)?.[1]?.trim() : "";
	const rawName = toolName.slice(prefix.length);
	const fallbackApp = rawName.split("_").at(0) ?? "app";
	const appLabel = descriptionApp || humanizeIdentifier(fallbackApp);
	const appSlug = slugIdentifier(appLabel || fallbackApp);

	let displayName = rawName;
	while (appSlug && displayName.startsWith(`${appSlug}_`)) {
		displayName = displayName.slice(appSlug.length + 1);
	}

	return {
		appLabel,
		displayName: displayName || rawName,
	};
}

const AGENT_TOOL_SET: ReadonlySet<string> = new Set(AGENT_TOOL_NAMES);

// Display prefix only: AGENT_TOOL_NAMES stays bare on the wire and in onToolReach.
// `functions.` is codex's top-level API namespace, and it never stacks on another one.
// `mcp__` and `codex_apps_` are namespaces too, spelled with the separators the provider accepts, so toolTabFor sorts them out.
export function toolRowLabel(toolName: string, reach: ToolReach): string {
	const namespaced = AGENT_TOOL_SET.has(toolName) ? `collaboration.${toolName}` : toolName;
	const alreadyNamespaced = namespaced.includes(".") || toolTabFor(toolName) !== "native";
	if (reach !== ToolReach.Direct || alreadyNamespaced) {
		return namespaced;
	}
	return `functions.${namespaced}`;
}

function markdownCodeBlock(language: string, content: string): string {
	let fence = "```";
	while (content.includes(fence)) {
		fence += "`";
	}
	return `${fence}${language}\n${content}\n${fence}`;
}

function formatTokenCount(tokens: number): string {
	return `~${fmt(tokens)} ${tokens === 1 ? "token" : "tokens"}`;
}

export type ToolDefinitionLookup = (name: string) => RegisteredToolDefinition | undefined;

// A schema of type object with no properties and `additionalProperties: false` admits nothing.
function schemaAdmitsNoInput(parameters: unknown): boolean {
	if (!parameters || typeof parameters !== "object") return false;
	const schema = parameters as Record<string, unknown>;
	if (schema.type !== "object" || schema.additionalProperties !== false) return false;
	const properties = schema.properties;
	if (properties === undefined) return true;
	if (!properties || typeof properties !== "object") return false;
	return Object.keys(properties).length === 0;
}

// pi calls `prepareArguments` with partial arguments on every call, so a probe is a call it already tolerates.
function discardsArguments(definition: RegisteredToolDefinition): boolean {
	const prepare = definition.prepareArguments;
	if (typeof prepare !== "function") return false;
	try {
		const prepared = (prepare as (args: unknown) => unknown)({ tokenBurdenProbe: 1 });
		return !!prepared && typeof prepared === "object" && Object.keys(prepared).length === 0;
	} catch {
		return false;
	}
}

// Two registry facts identify a placeholder: the schema admits no input, and `prepareArguments` drops every argument.
// A registration that declares nothing and then drops what arrives is not the schema the model sees.
// The swap at native-tools.ts:122 keys on the function tool's own name, so the name is the provider type.
export function providerOwnedToolType(
	name: string,
	lookup: ToolDefinitionLookup = getRegisteredTool,
): string | undefined {
	const definition = lookup(name);
	if (!definition) return undefined;
	const declared = definition.providerToolType;
	if (typeof declared === "string" && declared.length > 0) return declared;
	if (!schemaAdmitsNoInput(definition.parameters)) return undefined;
	return discardsArguments(definition) ? name : undefined;
}

function providerSchemaLines(providerType: string, placeholder: unknown): string[] {
	return [
		"",
		"#### Input schema",
		"",
		"- Owner: the provider. This registration is a placeholder.",
		`- Provider tool type: \`${providerType}\``,
		"- The placeholder declares no properties and sets `additionalProperties: false`.",
		"- `prepareArguments` drops every argument, so nothing the model sends is bound here.",
		`- The request builder replaces the placeholder with a provider tool of type \`${providerType}\`.`,
		"- The provider defines that tool's fields. This panel cannot read them.",
		"",
		"Placeholder schema:",
		"",
		markdownCodeBlock("json", JSON.stringify(placeholder, null, 2)),
	];
}

export function formatToolMarkdown(tool: ToolEntry, headingLevel = 3, lookup?: ToolDefinitionLookup): string {
	const parsed = parseToolContent(tool);
	const description = objectValue(parsed, "description");
	const parameters = objectValue(parsed, "input_schema");
	const tokens = Number.isFinite(tool.tokens) ? tool.tokens : 0;
	const chars = Number.isFinite(tool.chars) ? tool.chars : 0;
	const heading = `${"#".repeat(headingLevel)} ${toolRowLabel(toolDisplayName(tool), tool.reach)} (${formatTokenCount(tokens)})`;
	const costLabel = tool.reach === ToolReach.Direct ? "Resident tokens" : "Tokens if it were resident";
	const lines = [
		heading,
		"",
		`- State: ${toolReachLabel(tool.reach)} — ${toolReachDescription(tool.reach)}`,
		`- ${costLabel}: ~${fmt(tokens)} (estimated from the serialized schema)`,
		`- Characters: ${fmt(chars)}`,
	];

	if (typeof description === "string" && description.trim()) {
		lines.push("", description.trim());
	}

	const providerType = providerOwnedToolType(toolDisplayName(tool), lookup);
	if (providerType) {
		lines.push(...providerSchemaLines(providerType, parameters ?? {}));
	} else if (parameters !== undefined) {
		lines.push("", "#### Input schema", "", markdownCodeBlock("json", JSON.stringify(parameters, null, 2)));
	} else if (typeof parsed === "object") {
		lines.push("", "#### Definition", "", markdownCodeBlock("json", JSON.stringify(parsed, null, 2)));
	} else {
		lines.push(
			"",
			"#### Definition",
			"",
			markdownCodeBlock("text", typeof tool.content === "string" ? tool.content : ""),
		);
	}

	return lines.join("\n");
}

export function formatToolSectionMarkdown(tools: ToolSectionData, lookup?: ToolDefinitionLookup): string {
	const deferredTokens = tools.registeredTokens - tools.residentTokens;
	const sections = [
		"# Tool schemas",
		"",
		"Token counts here are estimated from the serialized schemas — the provider reports one prompt total, never a per-tool split. The measured figure these sit inside is the session floor.",
		"",
		`- Resident: ~${fmt(tools.residentTokens)} tokens of schema in the tool array the provider sees, so the model calls them without a cell`,
		`- Declared: ~${fmt(tools.declarationTokens)} tokens of one-line signatures in the system prompt; the body is called from a cell`,
		`- Deferred: ~${fmt(deferredTokens)} tokens registered and callable from a cell, found through ALL_TOOLS, costing nothing until called`,
		"",
	];

	for (const reach of TOOL_REACH_ORDER) {
		const entries = tools.tools
			.filter((tool) => tool.reach === reach)
			.toSorted((left, right) =>
				toolRowLabel(toolDisplayName(left), left.reach).localeCompare(
					toolRowLabel(toolDisplayName(right), right.reach),
				),
			);
		if (entries.length === 0) {
			continue;
		}
		const tokens = entries.reduce((sum, tool) => sum + tool.tokens, 0);
		sections.push(
			`## ${toolReachLabel(reach)} (${String(entries.length)}, ${formatTokenCount(tokens)})`,
			"",
			toolReachDescription(reach),
			"",
			entries.map((tool) => formatToolMarkdown(tool, 3, lookup)).join("\n\n"),
			"",
		);
	}

	return `${sections.join("\n")}\n`;
}

const REACH_COLUMN_WIDTH = 11;
const TOKEN_COLUMN_WIDTH = 11;

function countByReach(entries: readonly ToolEntry[], reach: ToolReach): number {
	return entries.filter((tool) => tool.reach === reach).length;
}

function plural(count: number, word: string): string {
	return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
}

// The Deferred number is a saving stated as a saving: registered, cell-reachable, unspent.
function renderToolCostSummary(
	lines: string[],
	tools: ToolSectionData,
	innerW: number,
	row: (content: string) => string,
): void {
	const directCount = countByReach(tools.tools, ToolReach.Direct);
	const declaredCount = countByReach(tools.tools, ToolReach.Declared);
	const rows: [string, number, string][] = [
		["Resident", tools.residentTokens, `${plural(directCount, "schema")} in the tool array; no cell needed`],
		[
			"Deferred",
			tools.registeredTokens - tools.residentTokens,
			`${plural(tools.tools.length - directCount, "tool")} in ALL_TOOLS; free until called`,
		],
	];

	if (tools.declarationTokens > 0) {
		rows.splice(1, 0, [
			"Declared",
			tools.declarationTokens,
			`${plural(declaredCount, "signature")} in the prompt; body runs in a cell`,
		]);
	}

	for (const [label, tokens, note] of rows) {
		const head = `${label.padEnd(13)}${`~${fmt(tokens)} tok`.padStart(12)}`;
		const noteWidth = Math.max(0, innerW - visibleWidth(head) - 5);
		lines.push(row(`${head}   ${dim(truncateToWidthCompat(note, noteWidth, "…"))}`));
	}
}

function toolLegend(entries: readonly ToolEntry[]): string {
	return TOOL_REACH_ORDER.map((reach) => ({ reach, count: countByReach(entries, reach) }))
		.filter(({ count }) => count > 0)
		.map(
			({ reach, count }) =>
				`${sgr(REACH_STYLE[reach].color, REACH_STYLE[reach].glyph)} ${count} ${toolReachLabel(reach)}`,
		)
		.join("  ");
}

class BudgetOverlay {
	private state: OverlayState = {
		mode: "sections",
		selectedIndex: 0,
		scrollOffset: 0,
		searchActive: false,
		searchQuery: "",
		drilldownSection: null,
		toolsSection: null,
		toolTab: "native",
		toolTabCursor: new Map(),
		collapsedToolGroups: new Set(),
		pendingChanges: new Map(),
		confirmingDiscard: false,
		traceResult: null,
		traceLoading: false,
		traceDrilldownBucket: null,
	};

	private tableItems: TableItem[];
	private parsed: ParsedPrompt;
	private originalParsed: ParsedPrompt;
	private originalTotalTokens: number;
	private adjustedTotalTokens: number;
	private contextWindow: number | undefined;
	private sessionUsage: SessionUsageData | undefined;
	private readonly discoveredSkills: SkillInfo[];
	private readonly tui: TUI;
	private done: (value: null) => void;
	private onToggleResult?: (result: SkillToggleResult) => boolean;
	private onToolReach?: ToolReachHandler;
	private onRunTrace?: () => Promise<BasePromptTraceResult>;

	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		tui: TUI,
		parsed: ParsedPrompt,
		contextWindow: number | undefined,
		sessionUsage: SessionUsageData | undefined,
		discoveredSkills: SkillInfo[],
		done: (value: null) => void,
		onToggleResult?: (result: SkillToggleResult) => boolean,
		onRunTrace?: () => Promise<BasePromptTraceResult>,
		onToolReach?: ToolReachHandler,
	) {
		this.tui = tui;
		this.parsed = parsed;
		this.originalParsed = {
			...parsed,
			sections: parsed.sections.map((s) => ({ ...s })),
		};
		this.originalTotalTokens = parsed.totalTokens;
		this.adjustedTotalTokens = parsed.totalTokens;
		this.contextWindow = contextWindow;
		this.sessionUsage = sessionUsage;
		this.discoveredSkills = discoveredSkills;
		this.tableItems = buildTableItems(parsed);
		this.done = done;
		this.onToggleResult = onToggleResult;
		this.onRunTrace = onRunTrace;
		this.onToolReach = onToolReach;
	}

	// -----------------------------------------------------------------------
	// Input handling
	// -----------------------------------------------------------------------

	handleInput(data: string): void {
		if (this.state.mode === "skill-toggle") {
			this.handleSkillToggleInput(data);
			return;
		}

		if (this.state.mode === "tools") {
			this.handleToolsInput(data);
			return;
		}

		if (this.state.mode === "turns") {
			if (isBackKey(data)) {
				this.state.mode = "sections";
				this.state.selectedIndex = 0;
				this.state.scrollOffset = 0;
				this.invalidate();
			} else if (isNavigateUpKey(data)) {
				this.moveSelection(-1);
			} else if (isNavigateDownKey(data)) {
				this.moveSelection(1);
			}
			return;
		}

		if (this.state.mode === "trace" || this.state.mode === "trace-drilldown") {
			this.handleTraceInput(data);
			return;
		}

		if (this.state.searchActive) {
			this.handleSearchInput(data);
			return;
		}

		if (this.state.mode === "drilldown" && isBackKey(data)) {
			this.state.mode = "sections";
			this.state.drilldownSection = null;
			this.state.selectedIndex = 0;
			this.state.scrollOffset = 0;
			this.invalidate();
			return;
		}

		if (this.state.mode === "sections" && isCloseKey(data)) {
			this.done(null);
			return;
		}

		if (isNavigateUpKey(data)) {
			this.moveSelection(-1);
			return;
		}

		if (isNavigateDownKey(data)) {
			this.moveSelection(1);
			return;
		}

		if (isForwardKey(data)) {
			this.drillIn();
			return;
		}

		if (data === "e") {
			if (this.state.mode === "sections") {
				this.openSectionInEditor();
			} else if (this.state.mode === "drilldown") {
				this.openDrilldownItemInEditor();
			}
			return;
		}

		if (data === "u") {
			if (this.state.mode === "sections" && (this.sessionUsage?.turns.length ?? 0) > 0) {
				this.state.mode = "turns";
				this.state.selectedIndex = 0;
				this.state.scrollOffset = 0;
				this.state.searchActive = false;
				this.invalidate();
			}
			return;
		}

		if (data === "t") {
			if (this.state.mode === "sections") {
				const items = this.getVisibleItems();
				const selected = items[this.state.selectedIndex];
				if (selected?.label.startsWith("Base")) {
					this.runTrace();
				}
			}
			return;
		}

		if (data === "/") {
			this.state.searchActive = true;
			this.state.searchQuery = "";
			this.invalidate();
		}
	}

	private handleSearchInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.state.searchActive = false;
			this.state.searchQuery = "";
			this.state.selectedIndex = 0;
			this.state.scrollOffset = 0;
			this.invalidate();
			return;
		}

		if (matchesKey(data, "up")) {
			this.moveSelection(-1);
			return;
		}

		if (matchesKey(data, "down")) {
			this.moveSelection(1);
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.state.searchQuery.length > 0) {
				this.state.searchQuery = this.state.searchQuery.slice(0, -1);
				this.state.selectedIndex = 0;
				this.state.scrollOffset = 0;
				this.invalidate();
			}
			return;
		}

		// Printable character
		if (data.length === 1 && (data.codePointAt(0) ?? 0) >= 32) {
			this.state.searchQuery += data;
			this.state.selectedIndex = 0;
			this.state.scrollOffset = 0;
			this.invalidate();
		}
	}

	private moveSelection(delta: number): void {
		let itemCount: number;
		if (this.state.mode === "skill-toggle") {
			itemCount = this.getFilteredSkills().length;
		} else if (this.state.mode === "tools") {
			itemCount = this.getToolsRows().length;
		} else if (this.state.mode === "turns") {
			itemCount = this.sessionUsage?.turns.length ?? 0;
		} else if (this.state.mode === "trace") {
			itemCount = this.state.traceResult?.buckets.length ?? 0;
		} else if (this.state.mode === "trace-drilldown") {
			const bucket = this.state.traceDrilldownBucket;
			itemCount = bucket ? this.getTraceEvidenceForBucket(bucket).length : 0;
		} else {
			itemCount = this.getVisibleItems().length;
		}
		if (itemCount === 0) {
			return;
		}

		let next = this.state.selectedIndex + delta;
		if (next < 0) {
			next = itemCount - 1;
		}
		if (next >= itemCount) {
			next = 0;
		}
		this.state.selectedIndex = next;

		// Adjust scroll offset to keep selection visible
		if (next < this.state.scrollOffset) {
			this.state.scrollOffset = next;
		} else if (next >= this.state.scrollOffset + MAX_VISIBLE_ROWS) {
			this.state.scrollOffset = next - MAX_VISIBLE_ROWS + 1;
		}

		this.invalidate();
	}

	private drillIn(): void {
		if (this.state.mode !== "sections") {
			return;
		}
		const items = this.getVisibleItems();
		const selected = items[this.state.selectedIndex];
		if (!selected?.drillable) {
			return;
		}

		if (selected.label.startsWith("Skills") && this.discoveredSkills.length > 0) {
			this.state.mode = "skill-toggle";
			this.state.selectedIndex = 0;
			this.state.scrollOffset = 0;
			this.state.searchActive = false;
			this.state.searchQuery = "";
			this.invalidate();
			return;
		}

		if (selected.tools) {
			this.state.mode = "tools";
			this.state.toolsSection = selected;
			this.state.toolTab = "native";
			this.state.toolTabCursor.clear();
			this.state.selectedIndex = 0;
			this.state.scrollOffset = 0;
			this.state.searchActive = false;
			this.state.searchQuery = "";
			this.invalidate();
			return;
		}

		this.state.mode = "drilldown";
		this.state.drilldownSection = selected;
		this.state.selectedIndex = 0;
		this.state.scrollOffset = 0;
		this.state.searchActive = false;
		this.state.searchQuery = "";
		this.invalidate();
	}

	private getVisibleItems(): TableItem[] {
		const baseItems =
			this.state.mode === "drilldown" ? (this.state.drilldownSection?.children ?? []) : this.tableItems;

		if (this.state.searchActive && this.state.searchQuery) {
			return fuzzyFilter(baseItems, this.state.searchQuery, (item) => item.label);
		}

		return baseItems;
	}

	private handleToolsInput(data: string): void {
		// isBackKey matches h, so the tab keys are read first and back narrows to esc or q.
		if (data === "h" || matchesKey(data, "left")) {
			this.moveToolTab(-1);
			return;
		}

		if (data === "l" || matchesKey(data, "right")) {
			this.moveToolTab(1);
			return;
		}

		if (isCloseKey(data)) {
			this.state.mode = "sections";
			this.state.toolsSection = null;
			this.state.selectedIndex = 0;
			this.state.scrollOffset = 0;
			this.invalidate();
			return;
		}

		if (isNavigateUpKey(data)) {
			this.moveSelection(-1);
			return;
		}

		if (isNavigateDownKey(data)) {
			this.moveSelection(1);
			return;
		}

		/**
		 * Blocking is on its own key.
		 *
		 * It writes tool-policy's persisted hidden set and refuses the tool inside
		 * cells too, so it is not something enter should do on the way past. Enter
		 * keeps the harmless meaning it has everywhere else in this overlay: open
		 * the thing under the cursor.
		 */
		if (isForwardKey(data)) {
			const row = this.getToolsRows()[this.state.selectedIndex];
			if (row?.kind === "group") {
				this.toggleToolGroupCollapsed(row);
			} else if (row) {
				this.openSelectedToolInEditor();
			}
			return;
		}

		if (data === " ") {
			const row = this.getToolsRows()[this.state.selectedIndex];
			if (row?.kind === "tool") {
				this.requestToolReach(row, nextToolReach(row.reach));
			}
			return;
		}

		if (data === "e") {
			this.openSelectedToolInEditor();
		}
	}

	/** Saves selectedIndex and scrollOffset per tab, so a short list never inherits a long list's index. */
	private moveToolTab(delta: number): void {
		this.state.toolTabCursor.set(this.state.toolTab, {
			selectedIndex: this.state.selectedIndex,
			scrollOffset: this.state.scrollOffset,
		});
		const index = TOOL_TABS.indexOf(this.state.toolTab);
		this.state.toolTab = TOOL_TABS[(index + delta + TOOL_TABS.length) % TOOL_TABS.length] ?? "native";

		const saved = this.state.toolTabCursor.get(this.state.toolTab);
		const rowCount = this.getToolsRows().length;
		this.state.selectedIndex = Math.min(saved?.selectedIndex ?? 0, Math.max(0, rowCount - 1));
		this.state.scrollOffset = Math.min(saved?.scrollOffset ?? 0, Math.max(0, rowCount - MAX_VISIBLE_ROWS));
		if (this.state.selectedIndex < this.state.scrollOffset) {
			this.state.scrollOffset = this.state.selectedIndex;
		}
		this.invalidate();
	}

	private toolsInTab(tab: ToolTab): ToolEntry[] {
		return filterToolsByTab(this.state.toolsSection?.tools?.tools ?? [], tab);
	}

	private toolTabBar(): string {
		return TOOL_TABS.map((tab) => {
			const label = `${TOOL_TAB_LABELS[tab]} ${fmt(this.toolsInTab(tab).length)}`;
			return tab === this.state.toolTab ? bold(sgr("36", label)) : dim(label);
		}).join(dim("  ·  "));
	}

	// One block of rows per state in TOOL_REACH_ORDER; inside a block, alphabetical by displayed label.
	// The codex connectors collapse into one row per app, or 320 of them are the entire view.
	private getToolsRows(): ToolsRow[] {
		const section = this.state.toolsSection?.tools;
		if (!section) {
			return [];
		}

		const rows: ToolsRow[] = [];
		const tabTools = filterToolsByTab(section.tools, this.state.toolTab);

		for (const reach of TOOL_REACH_ORDER) {
			const plainRows: ToolRow[] = [];
			const codexGroups = new Map<string, ToolRow[]>();

			for (const tool of tabTools) {
				if (tool.reach !== reach) {
					continue;
				}
				const toolName = toolDisplayName(tool);
				const info = codexAppToolInfo(tool);
				const row: ToolRow = {
					kind: "tool",
					label: info?.displayName ?? toolRowLabel(toolName, reach),
					toolName,
					reach,
					chars: Number.isFinite(tool.chars) ? tool.chars : 0,
					tokens: Number.isFinite(tool.tokens) ? tool.tokens : 0,
					content: typeof tool.content === "string" ? tool.content : "",
				};
				if (info) {
					codexGroups.set(info.appLabel, [...(codexGroups.get(info.appLabel) ?? []), row]);
				} else {
					plainRows.push(row);
				}
			}

			rows.push(...plainRows.toSorted((left, right) => left.label.localeCompare(right.label)));

			for (const [appLabel, appRows] of [...codexGroups.entries()].toSorted(([left], [right]) =>
				left.localeCompare(right),
			)) {
				const groupKey = `${reach}/${appLabel}`;
				const sortedRows = appRows
					.toSorted((left, right) => left.label.localeCompare(right.label))
					.map((row) => ({ ...row, indented: true }));
				const header: ToolGroupRow = {
					kind: "group",
					label: `Codex Apps / ${appLabel}`,
					groupKey,
					reach,
					tools: sortedRows,
					tokens: sortedRows.reduce((sum, row) => sum + row.tokens, 0),
					collapsed: this.state.collapsedToolGroups.has(groupKey),
				};
				rows.push(header, ...(header.collapsed ? [] : sortedRows));
			}
		}

		return rows;
	}

	// tool-policy owns the legal transitions and pins exec and wait to Direct; a refusal leaves the row.
	private requestToolReach(row: ToolRow, reach: ToolReach): void {
		if (!this.onToolReach?.(row.toolName, reach)) {
			return;
		}

		const entry = this.state.toolsSection?.tools?.tools.find((tool) => toolDisplayName(tool) === row.toolName);
		if (entry) {
			entry.reach = reach;
		}

		const rows = this.getToolsRows();
		const movedTo = rows.findIndex((next) => next.kind === "tool" && next.toolName === row.toolName);
		this.state.selectedIndex =
			movedTo >= 0 ? movedTo : Math.min(this.state.selectedIndex, Math.max(0, rows.length - 1));
		this.state.scrollOffset = Math.max(0, Math.min(this.state.scrollOffset, this.state.selectedIndex));
		if (this.state.selectedIndex >= this.state.scrollOffset + MAX_VISIBLE_ROWS) {
			this.state.scrollOffset = this.state.selectedIndex - MAX_VISIBLE_ROWS + 1;
		}
		this.invalidate();
	}

	private toggleToolGroupCollapsed(row: ToolGroupRow): void {
		if (row.collapsed) {
			this.state.collapsedToolGroups.delete(row.groupKey);
		} else {
			this.state.collapsedToolGroups.add(row.groupKey);
		}
		const rowCount = this.getToolsRows().length;
		this.state.selectedIndex = Math.min(this.state.selectedIndex, Math.max(0, rowCount - 1));
		this.state.scrollOffset = Math.min(this.state.scrollOffset, Math.max(0, rowCount - MAX_VISIBLE_ROWS));
		this.invalidate();
	}

	// -----------------------------------------------------------------------
	// Skill toggle
	// -----------------------------------------------------------------------

	private handleSkillToggleInput(data: string): void {
		if (this.state.confirmingDiscard) {
			if (data === "y" || data === "Y") {
				this.state.mode = "sections";
				this.state.pendingChanges = new Map();
				this.state.confirmingDiscard = false;
				this.state.selectedIndex = 0;
				this.state.scrollOffset = 0;
				this.recalculateTokens();
				this.invalidate();
				return;
			}
			if (data === "n" || data === "N" || isBackKey(data)) {
				this.state.confirmingDiscard = false;
				this.invalidate();
				return;
			}
			return;
		}

		if (this.state.searchActive) {
			this.handleSearchInput(data);
			return;
		}

		if (isBackKey(data)) {
			if (this.state.pendingChanges.size > 0) {
				this.state.confirmingDiscard = true;
				this.invalidate();
				return;
			}
			this.state.mode = "sections";
			this.state.selectedIndex = 0;
			this.state.scrollOffset = 0;
			this.invalidate();
			return;
		}

		if (isNavigateUpKey(data)) {
			this.moveSelection(-1);
			return;
		}

		if (isNavigateDownKey(data)) {
			this.moveSelection(1);
			return;
		}

		if (isToggleKey(data)) {
			this.cycleSkillState();
			return;
		}

		if (matchesKey(data, "ctrl+s")) {
			this.saveSkillChanges();
			return;
		}

		if (data === "e") {
			this.openSkillInEditor();
			return;
		}

		if (data === "/") {
			this.state.searchActive = true;
			this.state.searchQuery = "";
			this.invalidate();
		}
	}

	private cycleSkillState(): void {
		const visibleSkills = this.getFilteredSkills();
		const skill = visibleSkills[this.state.selectedIndex];
		if (!skill) {
			return;
		}

		const current = this.getEffectiveMode(skill);
		let next: DisableMode;
		if (current === DisableMode.Enabled) {
			next = DisableMode.Hidden;
		} else if (current === DisableMode.Hidden) {
			next = DisableMode.Disabled;
		} else {
			next = DisableMode.Enabled;
		}

		if (next === skill.mode) {
			this.state.pendingChanges.delete(skill.name);
		} else {
			this.state.pendingChanges.set(skill.name, next);
		}

		this.recalculateTokens();
		this.invalidate();
	}

	private getEffectiveMode(skill: SkillInfo): DisableMode {
		return this.state.pendingChanges.get(skill.name) ?? skill.mode;
	}

	private recalculateTokens(): void {
		let tokenDelta = 0;
		for (const [name, newMode] of this.state.pendingChanges) {
			const skill = this.discoveredSkills.find((s) => s.name === name);
			if (!skill) {
				continue;
			}

			const wasInPrompt = skill.mode === DisableMode.Enabled;
			const willBeInPrompt = newMode === DisableMode.Enabled;

			if (wasInPrompt && !willBeInPrompt) {
				tokenDelta -= skill.tokens;
			} else if (!wasInPrompt && willBeInPrompt) {
				tokenDelta += skill.tokens;
			}
		}

		this.adjustedTotalTokens = this.originalTotalTokens + tokenDelta;
		this.parsed = this.getAdjustedParsed();
		this.tableItems = buildTableItems(this.parsed);
		this.invalidate();
	}

	private getAdjustedParsed(): ParsedPrompt {
		const sections = this.originalParsed.sections.map((s) => ({ ...s }));

		// Find the skills section and adjust its token count
		const skillsSection = sections.find((s) => s.label.startsWith("Skills"));
		if (skillsSection) {
			const originalSkillsTokens =
				this.originalParsed.sections.find((s) => s.label.startsWith("Skills"))?.tokens ?? 0;

			let delta = 0;
			for (const [name, newMode] of this.state.pendingChanges) {
				const skill = this.discoveredSkills.find((s) => s.name === name);
				if (!skill) {
					continue;
				}

				const wasInPrompt = skill.mode === DisableMode.Enabled;
				const willBeInPrompt = newMode === DisableMode.Enabled;

				if (wasInPrompt && !willBeInPrompt) {
					delta -= skill.tokens;
				} else if (!wasInPrompt && willBeInPrompt) {
					delta += skill.tokens;
				}
			}

			skillsSection.tokens = originalSkillsTokens + delta;
		}

		return {
			sections,
			totalChars: this.originalParsed.totalChars,
			totalTokens: this.adjustedTotalTokens,
			skills: this.originalParsed.skills,
		};
	}

	private saveSkillChanges(): void {
		if (this.state.pendingChanges.size === 0) {
			return;
		}

		const success =
			this.onToggleResult?.({
				applied: true,
				changes: new Map(this.state.pendingChanges),
			}) ?? true;

		if (success) {
			// Update discoveredSkills to reflect the persisted state so the
			// UI doesn't snap back to stale modes after clearing pendingChanges.
			for (const [name, newMode] of this.state.pendingChanges) {
				const skill = this.discoveredSkills.find((s) => s.name === name);
				if (skill) {
					skill.mode = newMode;
				}
			}

			// Rebase the "original" token counts so subsequent toggles compute
			// deltas against the newly persisted state, not the initial load.
			this.originalTotalTokens = this.adjustedTotalTokens;
			this.originalParsed = {
				...this.parsed,
				sections: this.parsed.sections.map((s) => ({ ...s })),
			};

			this.state.pendingChanges = new Map();
			this.state.confirmingDiscard = false;
		}

		this.invalidate();
	}

	private openSkillInEditor(): void {
		const visibleSkills = this.getFilteredSkills();
		const skill = visibleSkills[this.state.selectedIndex];
		if (!skill?.filePath) {
			return;
		}

		this.launchEditor(skill.filePath);
	}

	private openDrilldownItemInEditor(): void {
		const items = this.getVisibleItems();
		const item = items[this.state.selectedIndex];
		if (!item) {
			return;
		}

		// If it's a path (AGENTS.md file), open it directly
		if (item.label.startsWith("/")) {
			this.launchEditor(item.label);
			return;
		}

		// If it has content (tool definition, etc.), write to temp file
		if (item.content) {
			this.openJsonContentInEditor(item.label, item.content);
		}
	}

	private toolReachHint(): string {
		const row = this.getToolsRows()[this.state.selectedIndex];
		if (row?.kind !== "tool" || !this.onToolReach) {
			return "";
		}
		return `${italic("space")} ${toolReachLabel(nextToolReach(row.reach))}  `;
	}

	private openSelectedToolInEditor(): void {
		const tool = this.getToolsRows()[this.state.selectedIndex];
		if (tool?.kind !== "tool" || !tool.content) {
			return;
		}

		this.openMarkdownContentInEditor(
			tool.toolName,
			formatToolMarkdown(
				{
					name: tool.toolName,
					chars: tool.chars,
					tokens: tool.tokens,
					content: tool.content,
					reach: tool.reach,
				},
				2,
			),
		);
	}

	private openSectionInEditor(): void {
		const items = this.getVisibleItems();
		const item = items[this.state.selectedIndex];
		if (!item) {
			return;
		}

		if (item.tools) {
			this.openMarkdownContentInEditor(item.label, formatToolSectionMarkdown(item.tools));
			return;
		}

		if (!item.content) {
			return;
		}

		const slug = sanitizeLabel(item.label);
		const tempPath = join(tmpdir(), `token-burden-${slug}-${randomUUID().slice(0, 8)}.md`);

		const header = isReadOnlySection(item.label) ? "<!-- Read-only view. Edits here have no effect. -->\n\n" : "";

		writeFileSync(tempPath, `${header}${item.content}`, "utf8");

		// Don't delete the temp file after the editor exits — editors like
		// VS Code (`code`) return immediately and read the file asynchronously.
		// Deleting it would race with the editor opening. The OS cleans /tmp.
		this.launchEditor(tempPath);
	}

	private launchEditor(filePath: string): void {
		const editorCmd = getEditor();
		const [editor, ...editorArgs] = editorCmd.split(" ");

		this.tui.stop();

		try {
			spawnSync(editor, [...editorArgs, filePath], {
				stdio: "inherit",
			});
		} finally {
			this.tui.start();
			this.tui.requestRender(true);
		}
	}

	private openJsonContentInEditor(label: string, content: string): void {
		const tempPath = join(tmpdir(), `token-burden-${sanitizeLabel(label)}-${randomUUID().slice(0, 8)}.json`);
		writeFileSync(tempPath, content, "utf8");
		this.launchEditor(tempPath);
	}

	private openMarkdownContentInEditor(label: string, content: string): void {
		const tempPath = join(tmpdir(), `token-burden-${sanitizeLabel(label)}-${randomUUID().slice(0, 8)}.md`);
		writeFileSync(tempPath, content, "utf8");
		this.launchEditor(tempPath);
	}

	private getFilteredSkills(): SkillInfo[] {
		if (this.state.searchActive && this.state.searchQuery) {
			return fuzzyFilter(this.discoveredSkills, this.state.searchQuery, (s) => s.name);
		}
		return this.discoveredSkills;
	}

	// -----------------------------------------------------------------------
	// Trace mode
	// -----------------------------------------------------------------------

	private handleTraceInput(data: string): void {
		if (isBackKey(data)) {
			if (this.state.mode === "trace-drilldown") {
				this.state.mode = "trace";
				this.state.traceDrilldownBucket = null;
				this.state.selectedIndex = 0;
				this.state.scrollOffset = 0;
				this.invalidate();
				return;
			}
			this.state.mode = "sections";
			this.state.selectedIndex = 0;
			this.state.scrollOffset = 0;
			this.invalidate();
			return;
		}

		if (isNavigateUpKey(data)) {
			this.moveSelection(-1);
			return;
		}

		if (isNavigateDownKey(data)) {
			this.moveSelection(1);
			return;
		}

		if (isForwardKey(data) && this.state.mode === "trace") {
			this.traceDetailDrillIn();
			return;
		}

		if (data === "r") {
			this.runTrace();
			return;
		}

		if (data === "e" && this.state.mode === "trace") {
			this.openTraceBucketInEditor();
		}
	}

	private traceDetailDrillIn(): void {
		const result = this.state.traceResult;
		if (!result) {
			return;
		}

		const bucket = result.buckets[this.state.selectedIndex];
		if (!bucket) {
			return;
		}

		const evidenceForBucket = result.evidence.filter((e) => {
			if (bucket.id === "built-in") {
				return e.bucket === "built-in";
			}
			if (bucket.id === "shared") {
				return e.bucket === "shared";
			}
			if (bucket.id === "unattributed") {
				return e.bucket === "unattributed";
			}
			return e.bucket === "extension" && e.contributors.includes(bucket.id);
		});

		if (evidenceForBucket.length === 0) {
			return;
		}

		this.state.mode = "trace-drilldown";
		this.state.traceDrilldownBucket = bucket;
		this.state.selectedIndex = 0;
		this.state.scrollOffset = 0;
		this.invalidate();
	}

	private openTraceBucketInEditor(): void {
		const result = this.state.traceResult;
		if (!result) {
			return;
		}

		const bucket = result.buckets[this.state.selectedIndex];
		if (!bucket || bucket.id === "built-in" || bucket.id === "shared" || bucket.id === "unattributed") {
			return;
		}

		this.launchEditor(bucket.id);
	}

	private async runTrace(): Promise<void> {
		if (!this.onRunTrace || this.state.traceLoading) {
			return;
		}

		const baseSection = this.parsed.sections.find((s) => s.label.startsWith("Base"));
		if (!baseSection?.content) {
			return;
		}

		this.state.traceLoading = true;
		this.state.mode = "trace";
		this.invalidate();

		try {
			const result = await this.onRunTrace();
			this.state.traceResult = result;
			this.state.traceLoading = false;
			this.state.selectedIndex = 0;
			this.state.scrollOffset = 0;
		} catch {
			this.state.traceLoading = false;
			this.state.mode = "sections";
		}
		this.invalidate();
		this.tui.requestRender(true);
	}

	private getTraceEvidenceForBucket(bucket: TraceBucket): TraceLineEvidence[] {
		const result = this.state.traceResult;
		if (!result) {
			return [];
		}

		return result.evidence.filter((e) => {
			if (bucket.id === "built-in") {
				return e.bucket === "built-in";
			}
			if (bucket.id === "shared") {
				return e.bucket === "shared";
			}
			if (bucket.id === "unattributed") {
				return e.bucket === "unattributed";
			}
			return e.bucket === "extension" && e.contributors.includes(bucket.id);
		});
	}

	private renderTrace(
		lines: string[],
		innerW: number,
		row: (content: string) => string,
		emptyRow: () => string,
		centerRow: (content: string) => string,
	): void {
		lines.push(emptyRow());

		if (this.state.traceLoading) {
			lines.push(centerRow(dim(italic("Analyzing extensions…"))));
			lines.push(emptyRow());
			return;
		}

		const result = this.state.traceResult;
		if (!result) {
			lines.push(centerRow(dim(italic("No trace data"))));
			lines.push(emptyRow());
			return;
		}

		if (this.state.mode === "trace-drilldown" && this.state.traceDrilldownBucket) {
			this.renderTraceDrilldown(lines, innerW, row, emptyRow, centerRow);
			return;
		}

		// Status line
		const status =
			result.errors.length > 0
				? sgr("33", `Trace partial (${result.errors.length} error${result.errors.length === 1 ? "" : "s"})`)
				: sgr("32", "Trace complete");
		const breadcrumb = `${bold("Base prompt")} → ${status}  ${dim("← esc")}`;
		lines.push(row(breadcrumb));
		lines.push(emptyRow());

		// Bucket rows
		const { buckets } = result;
		if (buckets.length === 0) {
			lines.push(centerRow(dim(italic("No attributable lines found"))));
			lines.push(emptyRow());
			return;
		}

		const startIdx = this.state.scrollOffset;
		const endIdx = Math.min(startIdx + MAX_VISIBLE_ROWS, buckets.length);

		for (let i = startIdx; i < endIdx; i++) {
			const bucket = buckets[i];
			const isSelected = i === this.state.selectedIndex;

			const prefix = isSelected ? sgr("36", "▸") : dim("·");
			const tokenStr = `~${fmt(bucket.tokens)} tokens`;
			const pctStr = `${bucket.pctOfBase.toFixed(1)}%`;
			const countStr = `${bucket.lineCount} line${bucket.lineCount === 1 ? "" : "s"}`;
			const suffix = `${countStr}  ${tokenStr}  ${pctStr}`;

			const suffixWidth = visibleWidth(suffix);
			const prefixWidth = 2;
			const gapMin = 2;
			const nameMaxWidth = innerW - prefixWidth - suffixWidth - gapMin - 3;

			const label = this.getTraceBucketLabel(bucket);
			const truncatedName = truncateToWidthCompat(isSelected ? bold(sgr("36", label)) : label, nameMaxWidth, "…");
			const nameWidth = visibleWidth(truncatedName);
			const gap = Math.max(1, innerW - prefixWidth - nameWidth - suffixWidth - 3);

			const content = `${prefix} ${truncatedName}${" ".repeat(gap)}${dim(suffix)}`;
			lines.push(`${dim("│")}${truncateToWidthCompat(` ${content}`, innerW, "…", true)}${dim("│")}`);
		}

		lines.push(emptyRow());

		// Scroll indicator
		if (buckets.length > MAX_VISIBLE_ROWS) {
			const progress = Math.round(((this.state.selectedIndex + 1) / buckets.length) * 10);
			const dots = rainbowDots(progress, 10);
			const countStr = `${this.state.selectedIndex + 1}/${buckets.length}`;
			lines.push(row(`${dots}  ${dim(countStr)}`));
			lines.push(emptyRow());
		}
	}

	private renderTraceDrilldown(
		lines: string[],
		innerW: number,
		row: (content: string) => string,
		emptyRow: () => string,
		centerRow: (content: string) => string,
	): void {
		const bucket = this.state.traceDrilldownBucket;
		if (!bucket) {
			return;
		}
		const evidence = this.getTraceEvidenceForBucket(bucket);

		const label = this.getTraceBucketLabel(bucket);
		const breadcrumb = `${bold(label)}  ${dim("← esc to go back")}`;
		lines.push(row(breadcrumb));
		lines.push(emptyRow());

		if (evidence.length === 0) {
			lines.push(centerRow(dim(italic("No evidence lines"))));
			lines.push(emptyRow());
			return;
		}

		const startIdx = this.state.scrollOffset;
		const endIdx = Math.min(startIdx + MAX_VISIBLE_ROWS, evidence.length);

		for (let i = startIdx; i < endIdx; i++) {
			const e = evidence[i];
			const isSelected = i === this.state.selectedIndex;

			const prefix = isSelected ? sgr("36", "▸") : dim("·");
			const tokenStr = `~${fmt(e.tokens)} tok`;
			const kindLabel = e.kind === "tool-line" ? "tool" : "guide";
			const suffix = `${kindLabel}  ${tokenStr}`;

			const suffixWidth = visibleWidth(suffix);
			const prefixWidth = 2;
			const gapMin = 2;
			const nameMaxWidth = innerW - prefixWidth - suffixWidth - gapMin - 3;

			const lineText = e.line.startsWith("- ") ? e.line.slice(2) : e.line;
			const truncatedLine = truncateToWidthCompat(
				isSelected ? bold(sgr("36", lineText)) : lineText,
				nameMaxWidth,
				"…",
			);
			const lineWidth = visibleWidth(truncatedLine);
			const gap = Math.max(1, innerW - prefixWidth - lineWidth - suffixWidth - 3);

			const content = `${prefix} ${truncatedLine}${" ".repeat(gap)}${dim(suffix)}`;
			lines.push(`${dim("│")}${truncateToWidthCompat(` ${content}`, innerW, "…", true)}${dim("│")}`);
		}

		lines.push(emptyRow());

		// Scroll indicator
		if (evidence.length > MAX_VISIBLE_ROWS) {
			const progress = Math.round(((this.state.selectedIndex + 1) / evidence.length) * 10);
			const dots = rainbowDots(progress, 10);
			const countStr = `${this.state.selectedIndex + 1}/${evidence.length}`;
			lines.push(row(`${dots}  ${dim(countStr)}`));
			lines.push(emptyRow());
		}

		// Show contributors for shared bucket
		if (bucket.id === "shared") {
			const selectedEvidence = evidence[this.state.selectedIndex];
			if (selectedEvidence && selectedEvidence.contributors.length > 1) {
				lines.push(row(dim("Contributors:")));
				for (const c of selectedEvidence.contributors) {
					lines.push(row(dim(`  • ${c}`)));
				}
				lines.push(emptyRow());
			}
		}
	}

	private getTraceBucketLabel(bucket: TraceBucket): string {
		if (bucket.id === "built-in") {
			return "Built-in/core";
		}
		if (bucket.id === "shared") {
			return "Shared (multi-extension)";
		}
		if (bucket.id === "unattributed") {
			return "Unattributed";
		}

		// Extract extension name from path
		const parts = bucket.id.split("/");
		const extDir = parts.findLast((p) => p !== "index.ts" && p !== "index.js" && p !== "src");
		return extDir ?? bucket.id;
	}

	private renderSkillToggle(
		lines: string[],
		innerW: number,
		row: (content: string) => string,
		emptyRow: () => string,
		centerRow: (content: string) => string,
	): void {
		lines.push(emptyRow());

		const pendingCount = this.state.pendingChanges.size;
		if (pendingCount > 0) {
			lines.push(
				row(sgr("33", `⚠ ${pendingCount} pending change${pendingCount === 1 ? "" : "s"} (Ctrl+S to save)`)),
			);
			lines.push(emptyRow());
		}

		const breadcrumb = `${bold("Skills")}  ${dim("← esc to go back")}`;
		lines.push(row(breadcrumb));

		// Search bar
		if (this.state.searchActive) {
			lines.push(emptyRow());
			const cursor = sgr("36", "│");
			const query = this.state.searchQuery
				? `${this.state.searchQuery}${cursor}`
				: `${cursor}${dim(italic("type to filter..."))}`;
			lines.push(row(`${dim("◎")}  ${query}`));
		}

		lines.push(emptyRow());

		// Skill rows
		const skills = this.getFilteredSkills();
		if (skills.length === 0) {
			lines.push(centerRow(dim(italic("No matching skills"))));
			lines.push(emptyRow());
			return;
		}

		const startIdx = this.state.scrollOffset;
		const endIdx = Math.min(startIdx + MAX_VISIBLE_ROWS, skills.length);

		for (let i = startIdx; i < endIdx; i++) {
			const skill = skills[i];
			const isSelected = i === this.state.selectedIndex;
			const mode = this.getEffectiveMode(skill);
			const hasChanged = this.state.pendingChanges.has(skill.name);

			const prefix = isSelected ? sgr("36", "▸") : dim("·");

			let statusIcon: string;
			if (mode === DisableMode.Enabled) {
				statusIcon = sgr("32", "●");
			} else if (mode === DisableMode.Hidden) {
				statusIcon = sgr("33", "◐");
			} else {
				statusIcon = sgr("31", "○");
			}

			const changedMarker = hasChanged ? sgr("33", "*") : " ";
			const dupMarker = skill.hasDuplicates ? sgr("35", "²") : " ";
			const nameStr = isSelected ? bold(sgr("36", skill.name)) : skill.name;

			const tokenStr = `~${fmt(skill.tokens)} tok`;
			const suffixWidth = visibleWidth(tokenStr);
			const prefixWidth = 8;
			const nameMaxWidth = innerW - prefixWidth - suffixWidth - 4;

			const truncatedName = truncateToWidthCompat(nameStr, nameMaxWidth, "…");
			const nameWidth = visibleWidth(truncatedName);
			const gap = Math.max(1, innerW - prefixWidth - nameWidth - suffixWidth - 3);

			const content = `${prefix} ${statusIcon}${changedMarker}${dupMarker}${truncatedName}${" ".repeat(gap)}${dim(tokenStr)}`;
			lines.push(row(content));
		}

		lines.push(emptyRow());

		// Legend
		lines.push(
			row(
				dim(
					`${sgr("32", "●")} on  ${sgr("33", "◐")} hidden  ${sgr("31", "○")} disabled  ${sgr("35", "²")} duplicates`,
				),
			),
		);

		// Scroll indicator
		if (skills.length > MAX_VISIBLE_ROWS) {
			const progress = Math.round(((this.state.selectedIndex + 1) / skills.length) * 10);
			const dots = rainbowDots(progress, 10);
			const countStr = `${this.state.selectedIndex + 1}/${skills.length}`;
			lines.push(row(`${dots}  ${dim(countStr)}`));
			lines.push(emptyRow());
		}

		// Discard confirmation
		if (this.state.confirmingDiscard) {
			lines.push(emptyRow());
			lines.push(
				row(
					`${sgr("33", `Discard ${this.state.pendingChanges.size} change${this.state.pendingChanges.size === 1 ? "" : "s"}? `)}${dim("(y/n)")}`,
				),
			);
		}
	}

	private renderToolsView(
		lines: string[],
		innerW: number,
		row: (content: string) => string,
		emptyRow: () => string,
		centerRow: (content: string) => string,
	): void {
		lines.push(emptyRow());

		const breadcrumb = `${bold("Tools")}  ${dim("← esc to go back")}`;
		lines.push(row(breadcrumb));
		lines.push(emptyRow());

		// renderToolCostSummary is the session total, so it sits above the tabs and ignores them.
		const section = this.state.toolsSection?.tools;
		if (section) {
			renderToolCostSummary(lines, section, innerW, row);
			lines.push(emptyRow());
		}

		lines.push(row(this.toolTabBar()));
		lines.push(emptyRow());

		const rows = this.getToolsRows();

		if (rows.length === 0) {
			lines.push(centerRow(dim(italic("No tools"))));
			lines.push(emptyRow());
			return;
		}

		const startIdx = this.state.scrollOffset;
		const endIdx = Math.min(startIdx + MAX_VISIBLE_ROWS, rows.length);

		for (let i = startIdx; i < endIdx; i++) {
			const tool = rows[i];
			const isSelected = i === this.state.selectedIndex;
			const prefix = isSelected ? sgr("36", "▸") : dim("·");
			const style = REACH_STYLE[tool.reach];
			const statusIcon = sgr(style.color, style.glyph);
			const indent = tool.kind === "tool" && tool.indented ? "  " : "";

			const label = tool.kind === "group" ? `${tool.collapsed ? "▸" : "▾"} ${tool.label}` : tool.label;
			const nameStr = isSelected ? bold(sgr("36", label)) : label;

			const stateStr =
				tool.kind === "group"
					? `${String(tool.tools.length)} ${toolReachLabel(tool.reach)}`
					: toolReachLabel(tool.reach);
			const tokenStr = `~${fmt(tool.tokens)} tok`;
			const suffix = `${stateStr.padStart(REACH_COLUMN_WIDTH)}  ${tokenStr.padStart(TOKEN_COLUMN_WIDTH)}`;
			const paintedSuffix =
				tool.reach === ToolReach.Direct
					? `${sgr(style.color, stateStr.padStart(REACH_COLUMN_WIDTH))}  ${tokenStr.padStart(TOKEN_COLUMN_WIDTH)}`
					: dim(suffix);

			const suffixWidth = visibleWidth(suffix);
			const prefixWidth = 5 + visibleWidth(indent);
			const nameMaxWidth = innerW - prefixWidth - suffixWidth - 4;
			const truncatedName = truncateToWidthCompat(nameStr, nameMaxWidth, "…");
			const nameWidth = visibleWidth(truncatedName);
			const gap = Math.max(1, innerW - prefixWidth - nameWidth - suffixWidth - 3);

			lines.push(row(`${prefix} ${indent}${statusIcon}  ${truncatedName}${" ".repeat(gap)}${paintedSuffix}`));
		}

		lines.push(emptyRow());
		lines.push(row(dim(toolLegend(this.toolsInTab(this.state.toolTab)))));

		if (rows.length > MAX_VISIBLE_ROWS) {
			const progress = Math.round(((this.state.selectedIndex + 1) / rows.length) * 10);
			const dots = rainbowDots(progress, 10);
			const countStr = `${this.state.selectedIndex + 1}/${rows.length}`;
			lines.push(row(`${dots}  ${dim(countStr)}`));
			lines.push(emptyRow());
		}
	}

	/**
	 * Every request, as the provider billed it.
	 *
	 * `context` is what was sent, `fresh` is the part of it that was not served
	 * from cache, and the gap between the two columns is the whole argument for
	 * why a token count alone cannot tell you what a turn cost.
	 */
	private renderTurnsView(
		lines: string[],
		row: (content: string) => string,
		emptyRow: () => string,
		centerRow: (content: string) => string,
	): void {
		lines.push(emptyRow());
		lines.push(row(`${bold("Turns")}  ${dim("← esc to go back")}  ${dim("every column provider-reported")}`));
		lines.push(emptyRow());

		const turns = this.sessionUsage?.turns ?? [];
		if (turns.length === 0) {
			lines.push(centerRow(dim(italic("No completed turns yet"))));
			lines.push(emptyRow());
			return;
		}

		const columns = (cells: [string, string, string, string, string, string]) =>
			`${cells[0].padStart(4)}${cells[1].padStart(11)}${cells[2].padStart(11)}${cells[3].padStart(11)}${cells[4].padStart(10)}${cells[5].padStart(11)}`;

		lines.push(row(dim(columns(["#", "context", "fresh", "cached", "output", "cost"]))));

		const startIdx = this.state.scrollOffset;
		const endIdx = Math.min(startIdx + MAX_VISIBLE_ROWS, turns.length);
		for (let i = startIdx; i < endIdx; i++) {
			const turn = turns[i];
			const cells = columns([
				String(turn.index),
				fmt(turn.promptTokens),
				fmt(turn.input),
				fmt(turn.cacheRead),
				fmt(turn.output),
				formatCost(turn.cost),
			]);
			lines.push(row(i === this.state.selectedIndex ? sgr("36", cells) : cells));
		}

		const totals = this.sessionUsage?.totals;
		if (totals) {
			lines.push(
				row(
					dim(
						// The context column has no total: each turn's is the whole
						// prompt, so adding them counts the same tokens once per turn.
						columns([
							"Σ",
							"—",
							fmt(totals.freshInput),
							fmt(totals.cacheRead),
							fmt(totals.output),
							formatCost(totals.cost),
						]),
					),
				),
			);
			lines.push(emptyRow());
			lines.push(
				row(
					dim(
						`floor ${fmt(totals.floorTokens)}, paid before the first question  ·  ${(totals.cachedShare * 100).toFixed(0)}% of all input cached`,
					),
				),
			);
		}

		if (turns.length > MAX_VISIBLE_ROWS) {
			const progress = Math.round(((this.state.selectedIndex + 1) / turns.length) * 10);
			lines.push(row(`${rainbowDots(progress, 10)}  ${dim(`${this.state.selectedIndex + 1}/${turns.length}`)}`));
		}
		lines.push(emptyRow());
	}

	// -----------------------------------------------------------------------
	// Rendering
	// -----------------------------------------------------------------------

	render(width: number): string[] {
		if (width < 4) return [];
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const w = Math.min(width, OVERLAY_WIDTH);
		const innerW = w - 2;
		const row = makeRow(innerW);
		const emptyRow = makeEmptyRow(innerW);
		const divider = makeDivider(innerW);
		const centerRow = makeCenterRow(innerW);

		const lines: string[] = [renderTitleBorder(innerW), emptyRow()];

		// Zone 1: Context window usage bar
		if (this.contextWindow) {
			renderContextWindowBar(
				lines,
				this.parsed,
				this.contextWindow,
				this.sessionUsage,
				innerW,
				row,
				emptyRow,
				divider,
			);
		}

		// Zone 2: the measured context first, then the estimate of the prompt inside it
		if (this.sessionUsage && this.sessionUsage.tokens > 0) {
			renderContextStackedBar(lines, this.sessionUsage, innerW, row);
			lines.push(emptyRow());
		}
		renderStackedBar(lines, this.parsed, innerW, row);
		lines.push(emptyRow());
		lines.push(divider());

		// Zone 3: Interactive table, skill toggle, or trace
		if (this.state.mode === "skill-toggle") {
			this.renderSkillToggle(lines, innerW, row, emptyRow, centerRow);
		} else if (this.state.mode === "tools") {
			this.renderToolsView(lines, innerW, row, emptyRow, centerRow);
		} else if (this.state.mode === "turns") {
			this.renderTurnsView(lines, row, emptyRow, centerRow);
		} else if (this.state.mode === "trace" || this.state.mode === "trace-drilldown") {
			this.renderTrace(lines, innerW, row, emptyRow, centerRow);
		} else {
			this.renderInteractiveTable(lines, innerW, row, emptyRow, centerRow);
		}

		// Footer
		lines.push(divider());
		lines.push(emptyRow());

		let hints: string;
		if (this.state.mode === "skill-toggle") {
			hints = `${italic("↑↓/jk")} navigate  ${italic("enter/l")} cycle state  ${italic("e")} edit  ${italic("/")} search  ${italic("ctrl+s")} save  ${italic("esc/h/q")} back`;
		} else if (this.state.mode === "tools") {
			hints = `${italic("↑↓/jk")} navigate  ${italic("h/l")} tab  ${italic("enter")} view  ${this.toolReachHint()}${italic("esc/q")} back`;
		} else if (this.state.mode === "turns") {
			hints = `${italic("↑↓/jk")} navigate  ${italic("esc/h/q")} back`;
		} else if (this.state.mode === "trace") {
			hints = `${italic("↑↓/jk")} navigate  ${italic("enter/l")} details  ${italic("e")} open  ${italic("r")} refresh  ${italic("esc/h/q")} back`;
		} else if (this.state.mode === "trace-drilldown") {
			hints = `${italic("↑↓/jk")} navigate  ${italic("esc/h/q")} back`;
		} else if (this.state.mode === "drilldown") {
			const hasEditableItems = this.state.drilldownSection?.children?.some(
				(c) => c.label.startsWith("/") || c.content,
			);
			hints = hasEditableItems
				? `${italic("↑↓/jk")} navigate  ${italic("e")} edit  ${italic("/")} search  ${italic("esc/h/q")} back`
				: `${italic("↑↓/jk")} navigate  ${italic("/")} search  ${italic("esc/h/q")} back`;
		} else {
			// sections mode
			const items = this.getVisibleItems();
			const selected = items[this.state.selectedIndex];
			const isBase = selected?.label.startsWith("Base");
			const traceHint = isBase && this.onRunTrace ? `  ${italic("t")} trace` : "";
			const turnsHint = (this.sessionUsage?.turns.length ?? 0) > 0 ? `  ${italic("u")} turns` : "";
			hints = `${italic("↑↓/jk")} navigate  ${italic("enter/l")} drill-in  ${italic("e")} view${traceHint}${turnsHint}  ${italic("/")} search  ${italic("esc/q")} close`;
		}
		lines.push(centerRow(dim(hints)));

		// Bottom border
		lines.push(dim(`╰${"─".repeat(innerW)}╯`));

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	private renderInteractiveTable(
		lines: string[],
		innerW: number,
		row: (content: string) => string,
		emptyRow: () => string,
		centerRow: (content: string) => string,
	): void {
		if (this.state.mode === "drilldown" && this.state.drilldownSection) {
			lines.push(emptyRow());
			const breadcrumb = `${bold(this.state.drilldownSection.label)}  ${dim("←  esc to go back")}`;
			lines.push(row(breadcrumb));
		}

		// Search bar
		if (this.state.searchActive) {
			lines.push(emptyRow());
			const cursor = sgr("36", "│");
			const query = this.state.searchQuery
				? `${this.state.searchQuery}${cursor}`
				: `${cursor}${dim(italic("type to filter..."))}`;
			lines.push(row(`${dim("◎")}  ${query}`));
		}

		lines.push(emptyRow());

		// Table rows
		const items = this.getVisibleItems();
		if (items.length === 0) {
			lines.push(centerRow(dim(italic("No matching items"))));
			lines.push(emptyRow());
		} else {
			const startIdx = this.state.scrollOffset;
			const endIdx = Math.min(startIdx + MAX_VISIBLE_ROWS, items.length);

			for (let i = startIdx; i < endIdx; i++) {
				const item = items[i];
				const isSelected = i === this.state.selectedIndex;
				lines.push(renderTableRow(item, isSelected, innerW));
			}

			lines.push(emptyRow());

			// Scroll indicator
			if (items.length > MAX_VISIBLE_ROWS) {
				const progress = Math.round(((this.state.selectedIndex + 1) / items.length) * 10);
				const dots = rainbowDots(progress, 10);
				const countStr = `${this.state.selectedIndex + 1}/${items.length}`;
				lines.push(row(`${dots}  ${dim(countStr)}`));
				lines.push(emptyRow());
			}
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function showReport(
	parsed: ParsedPrompt,
	contextWindow: number | undefined,
	ctx: ExtensionCommandContext,
	discoveredSkills?: SkillInfo[],
	onToggleResult?: (result: SkillToggleResult) => boolean,
	onRunTrace?: () => Promise<BasePromptTraceResult>,
	onToolReach?: ToolReachHandler,
	sessionUsage?: SessionUsageData,
): Promise<void> {
	await tokenBurdenTui.bind(ctx).overlays.openComponent<null>(
		(tui, _theme, _kb, done) => {
			const overlay = new BudgetOverlay(
				tui,
				parsed,
				contextWindow,
				sessionUsage,
				discoveredSkills ?? [],
				done,
				onToggleResult,
				onRunTrace,
				onToolReach,
			);
			return {
				render: (width: number) => overlay.render(width),
				invalidate: () => overlay.invalidate(),
				handleInput: (data: string) => {
					overlay.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: OVERLAY_WIDTH },
		},
	);
}
