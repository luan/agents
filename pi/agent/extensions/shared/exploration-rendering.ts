import { resourceOpenUrl } from "./resources.ts";

type ExplorationStatus = "running" | "done";

export type ExplorationReadSummaryPart = {
	text: string;
	role?: string;
	avatarUrl?: string;
	italic?: boolean;
	url?: string;
};

export type ExplorationReadSummaryRow = {
	icon?: string;
	iconRole?: string;
	leading?: string;
	leadingRole?: string;
	text: string;
	textRole?: string;
	italic?: boolean;
	textUrl?: string;
	prefix?: ExplorationReadSummaryPart;
	bold?: boolean;
	branch?: boolean;
	footer?: boolean;
	status?: ExplorationReadSummaryPart;
	details?: ExplorationReadSummaryPart[];
	avatarUrl?: string;
	/**
	 * Body text rendered as markdown under this row.
	 *
	 * A comment squeezed onto its author's line was a truncated fragment with
	 * its formatting intact as literal characters. The author identifies the
	 * row; the body is a body and renders as one.
	 */
	markdown?: string;
};

export type ExplorationReadSummary = {
	icon: string;
	iconRole: string;
	label: string;
	title: string;
	subtitle: string;
	identifier?: ExplorationReadSummaryPart;
	subtitleUrl?: string;
	meta?: string;
	metaParts?: ExplorationReadSummaryPart[];
	/**
	 * What the result cost, rendered at the end of the title row.
	 *
	 * On the title row rather than in `metaParts` so it sits in the same place
	 * for every read, whether or not that read has diff stats to show.
	 */
	costPart?: ExplorationReadSummaryPart;
	/**
	 * The resource URI this card was read from, rendered at the end of the
	 * subtitle row and linked to where the view opens on the web.
	 */
	uri?: ExplorationReadSummaryPart;
	statusLabel?: string;
	statusRole?: string;
	statusSuffix?: string;
	typeIcon?: string;
	hideIcon?: boolean;
	repository?: string;
	repositoryUrl?: string;
	author?: ExplorationReadSummaryPart;
	rows?: ExplorationReadSummaryRow[];
	sideRows?: ExplorationReadSummaryRow[];
};

type ExplorationAction =
	| {
			kind: "read";
			title?: string;
			body: string;
			path?: string;
			renderTarget: string;
			openUrl?: string;
			summary?: ExplorationReadSummary;
	  }
	| { kind: "find" | "search" | "list" | "run"; title: string; body: string };

interface ExplorationRenderTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

interface ExplorationEntry {
	toolCallId: string;
	action: ExplorationAction;
	status: ExplorationStatus;
	hidden: boolean;
	groupId?: number;
	invalidate?: () => void;
}

interface ExplorationGroup {
	id: number;
	entryIds: string[];
	visibleEntryId: string;
}

interface ExplorationRenderInfo {
	hidden: boolean;
	status: ExplorationStatus;
	actionGroups?: ExplorationAction[][];
}

type ArgsToAction = (args: unknown) => ExplorationAction | undefined;
type PiWithEvents = {
	on?: (event: string, handler: (event: any, context?: any) => void) => void;
};

const actionByToolName = new Map<string, ArgsToAction>();
const registeredPis = new WeakSet<object>();

const entriesByToolCallId = new Map<string, ExplorationEntry>();
const pendingInvalidatesByToolCallId = new Map<string, () => void>();
const summariesByToolCallId = new Map<string, ExplorationReadSummary>();
const groupsById = new Map<number, ExplorationGroup>();
let activeExplorationGroupId: number | undefined;
let nextGroupId = 1;

export function readAction(filePath: string | undefined, cwd?: string): ExplorationAction {
	const path = filePath ?? "";
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(path)?.[1]?.toLowerCase();
	return {
		kind: "read",
		body: path || "file",
		path,
		openUrl: scheme ? resourceOpenUrl(path, { cwd }) : undefined,
		renderTarget: scheme ? `read:${scheme}:${path}` : "read:file",
	};
}
export function updateExplorationRead(toolCallId: string | undefined, summary: ExplorationReadSummary): boolean {
	if (!toolCallId) return false;
	summariesByToolCallId.set(toolCallId, summary);
	const entry = entriesByToolCallId.get(toolCallId);
	if (!entry || entry.action.kind !== "read") return false;
	// Identity, not deep equality: this runs on every render, and a resource
	// summary carries the full record in its metadata — for a PR diff that is
	// megabytes. Two `JSON.stringify` calls per frame over that object is enough
	// allocation to drive the heap into continuous scavenging. Summaries are
	// built once per result and reused, so reference equality is the same test.
	if (entry.action.summary === summary) return true;
	entry.action = { ...entry.action, summary };
	entry.invalidate?.();
	return true;
}
export function getExplorationReadSummary(toolCallId: string | undefined): ExplorationReadSummary | undefined {
	if (!toolCallId) return undefined;
	const action = entriesByToolCallId.get(toolCallId)?.action;
	return summariesByToolCallId.get(toolCallId) ?? (action?.kind === "read" ? action.summary : undefined);
}

export function registerExplorationTool(toolName: string, toAction: ArgsToAction): void {
	actionByToolName.set(toolName, toAction);
}

export function registerExplorationEventHandlers(pi: PiWithEvents): void {
	if (!pi.on || registeredPis.has(pi)) return;
	registeredPis.add(pi);

	pi.on("session_start", (_event, context) => rebuildExplorationGroups(context));
	pi.on("session_tree", (_event, context) => rebuildExplorationGroups(context));
	pi.on("session_compact", (_event, context) => rebuildExplorationGroups(context));
	pi.on("session_shutdown", clearExplorationGroup);
	pi.on("message_start", (event) => {
		if (event.message?.role === "toolResult") return;
		if (isToolCallOnlyAssistantMessage(event.message)) return;
		resetExplorationGroup();
	});
	pi.on("tool_execution_start", (event) => {
		const toAction = actionByToolName.get(event.toolName);
		if (!toAction) {
			resetExplorationGroup();
			return;
		}
		const action = toAction(event.args);
		if (action) recordExplorationStart(event.toolCallId, action);
	});
	pi.on("tool_execution_end", (event) => {
		if (actionByToolName.has(event.toolName)) recordExplorationEnd(event.toolCallId);
	});
}

function rebuildExplorationGroups(context: unknown): void {
	clearExplorationGroup();
	if (!context || typeof context !== "object" || !("sessionManager" in context)) return;
	const sessionManager = context.sessionManager;
	if (!sessionManager || typeof sessionManager !== "object") return;
	const getEntries =
		"buildContextEntries" in sessionManager && typeof sessionManager.buildContextEntries === "function"
			? sessionManager.buildContextEntries
			: "getBranch" in sessionManager && typeof sessionManager.getBranch === "function"
				? sessionManager.getBranch
				: undefined;
	if (!getEntries) return;
	const branch = getEntries.call(sessionManager);
	if (!Array.isArray(branch)) return;

	for (const entry of branch) {
		if (!entry || typeof entry !== "object" || !("type" in entry)) continue;
		if (entry.type !== "message") {
			if (entry.type === "compaction" || entry.type === "branch_summary") resetExplorationGroup();
			continue;
		}
		if (!("message" in entry) || !entry.message || typeof entry.message !== "object" || !("role" in entry.message)) {
			continue;
		}
		const message = entry.message;
		if (message.role === "toolResult") {
			if ("toolCallId" in message && typeof message.toolCallId === "string")
				recordExplorationEnd(message.toolCallId);
			continue;
		}
		if (!isToolCallOnlyAssistantMessage(message)) resetExplorationGroup();
		if (message.role !== "assistant" || !("content" in message) || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!block || typeof block !== "object" || !("type" in block) || block.type !== "toolCall") continue;
			if (!("id" in block) || typeof block.id !== "string" || !("name" in block) || typeof block.name !== "string") {
				continue;
			}
			const toAction = actionByToolName.get(block.name);
			const action = toAction?.("arguments" in block ? block.arguments : undefined);
			if (action) recordExplorationStart(block.id, action);
			else resetExplorationGroup();
		}
	}
}

function registerExplorationRenderContext(toolCallId: string | undefined, invalidate: (() => void) | undefined): void {
	if (!toolCallId) return;
	const entry = entriesByToolCallId.get(toolCallId);
	if (entry) {
		entry.invalidate = invalidate;
		pendingInvalidatesByToolCallId.delete(toolCallId);
	} else if (invalidate) {
		pendingInvalidatesByToolCallId.set(toolCallId, invalidate);
	}
}

function getExplorationRenderInfo(
	toolCallId: string | undefined,
	fallbackStatus: ExplorationStatus,
): ExplorationRenderInfo {
	if (!toolCallId) return { hidden: false, status: fallbackStatus };
	const entry = entriesByToolCallId.get(toolCallId);
	if (!entry) return { hidden: false, status: fallbackStatus };
	if (entry.hidden) return { hidden: true, status: entry.status };

	const group = getGroupForEntry(entry);
	if (!group) {
		return {
			hidden: false,
			status: entry.status,
			actionGroups: [[entry.action]],
		};
	}

	const entries = group.entryIds
		.map((entryId) => entriesByToolCallId.get(entryId))
		.filter((groupEntry): groupEntry is ExplorationEntry => Boolean(groupEntry));
	return {
		hidden: false,
		status: entries.some((groupEntry) => groupEntry.status === "running") ? "running" : "done",
		actionGroups: entries.map((groupEntry) => [groupEntry.action]),
	};
}

function osc8Link(text: string, url: string | undefined): string {
	return url && !/[\u0000-\u001f\u007f]/.test(url) ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;
}

export function renderExplorationSummaryPart(part: ExplorationReadSummaryPart, theme: ExplorationRenderTheme): string {
	const text = part.italic ? `\x1b[3m${part.text}\x1b[23m` : part.text;
	return osc8Link(theme.fg(part.role ?? "muted", text), part.url);
}

function renderReadSummaryMeta(summary: ExplorationReadSummary, theme: ExplorationRenderTheme): string {
	const parts = [
		...(summary.metaParts ?? (summary.meta ? [{ text: summary.meta }] : [])),
		...(summary.uri ? [summary.uri] : []),
	];
	if (parts.length === 0) return "";
	const separator = theme.fg("dim", " · ");
	return ` ${theme.fg("dim", "·")} ${parts.map((part) => renderExplorationSummaryPart(part, theme)).join(separator)}`;
}

export function renderExplorationSummaryTitle(
	summary: ExplorationReadSummary,
	theme: ExplorationRenderTheme,
	padLabel = false,
): string {
	const status = summary.statusLabel
		? `${theme.fg(summary.statusRole ?? summary.iconRole, theme.bold(padLabel ? summary.statusLabel.padEnd(6) : summary.statusLabel))}${summary.statusSuffix ? ` ${summary.statusSuffix}` : ""} `
		: "";
	const cost = summary.costPart ? ` ${renderExplorationSummaryPart(summary.costPart, theme)}` : "";
	if (summary.typeIcon) {
		const repository = summary.repository
			? `${renderExplorationSummaryPart(
					{ text: summary.repository, role: "muted", italic: true, url: summary.repositoryUrl },
					theme,
				)} `
			: "";
		const icon = summary.hideIcon ? "" : `${theme.fg(summary.iconRole, summary.icon)} `;
		const identifier = summary.identifier ? `${renderExplorationSummaryPart(summary.identifier, theme)} ` : "";
		return `${theme.fg("text", summary.typeIcon)} ${repository}${theme.fg("text", theme.bold(summary.label))} ${icon}${status}${identifier}${theme.fg("accent", summary.title)}${cost}`;
	}
	return `${theme.fg(summary.iconRole, summary.icon)} ${status}${theme.bold(summary.label)} ${theme.fg("accent", summary.title)}${cost}`;
}

function renderReadSummaryRow(
	row: ExplorationReadSummaryRow,
	index: number,
	total: number,
	theme: ExplorationRenderTheme,
): string {
	const branch = row.branch === false ? "" : theme.fg("dim", `   ${index === total - 1 ? "└─" : "├─"} `);
	const leading = row.leading
		? row.leading.trim()
			? theme.fg(row.leadingRole ?? "muted", row.leading)
			: row.leading
		: "";
	const icon = row.icon ? `${theme.fg(row.iconRole ?? "muted", row.icon)} ` : "";
	const prefix = row.prefix ? `${renderExplorationSummaryPart(row.prefix, theme)} ` : "";
	const rowText = row.italic ? `\x1b[3m${row.text}\x1b[23m` : row.text;
	const styledRowText = row.bold ? theme.bold(rowText) : rowText;
	const body = row.textUrl
		? renderExplorationSummaryPart({ text: styledRowText, role: row.textRole, url: row.textUrl }, theme)
		: theme.fg(row.textRole ?? "muted", styledRowText);
	const details = row.details?.map((part) => renderExplorationSummaryPart(part, theme)).join(theme.fg("dim", " · "));
	const status = row.status ? renderExplorationSummaryPart(row.status, theme) : "";
	return `${branch}${leading}${icon}${prefix}${body}${details ? `${theme.fg("dim", " · ")}${details}` : ""}${status ? ` ${status}` : ""}`;
}
function renderActionBody(action: ExplorationAction, theme: ExplorationRenderTheme, role: string): string {
	if (action.kind === "read" && /^[a-z][a-z0-9+.-]*:\/\//i.test(action.body)) {
		return renderExplorationSummaryPart(
			{ text: action.body, role: "mdLink", italic: true, url: action.openUrl },
			theme,
		);
	}
	return theme.fg(role, action.body);
}

export function renderExplorationText(
	actionGroups: ExplorationAction[][],
	status: ExplorationStatus,
	theme: ExplorationRenderTheme,
	failed = false,
): string {
	const actions = actionGroups.flat();
	if (actions.length > 0 && actions.every((action) => action.kind === "read")) {
		const reads = actions.filter(
			(action, index) =>
				action.kind === "read" &&
				actions.findIndex((candidate) => candidate.kind === "read" && candidate.path === action.path) === index,
		);
		const marker = theme.fg(failed ? "error" : status === "running" ? "dim" : "accent", "●");
		const count = reads.length > 1 ? ` ${theme.fg("dim", `(${reads.length})`)}` : "";
		const summary = reads.length === 1 && reads[0]?.summary;
		if (summary) {
			let text = [
				` ${renderExplorationSummaryTitle(summary, theme)}`,
				` ${theme.fg("dim", "   └─ ")}${osc8Link(theme.fg("mdLink", summary.subtitle), summary.subtitleUrl)}${renderReadSummaryMeta(summary, theme)}`,
			].join("\n");
			const rows = [...(summary.sideRows ?? []), ...(summary.rows ?? [])];
			for (const [index, row] of rows.entries())
				text += `\n ${renderReadSummaryRow(row, index, rows.length, theme)}`;
			return text;
		}
		let text = `${marker} ${theme.bold("Read")}${count}`;
		for (const [index, read] of reads.entries()) {
			const branch = index === reads.length - 1 ? "└─" : "├─";
			text += `\n${theme.fg("dim", `   ${branch} `)}${renderActionBody(read, theme, "accent")}`;
		}
		return text;
	}

	const header = status === "running" ? "Exploring" : "Explored";
	let text = `${renderStatusMarker("•", status, theme, failed)} ${theme.bold(header)}`;
	for (const [index, action] of coalesceReadActions(actions).entries()) {
		const prefix = index === 0 ? "  └ " : "    ";
		const title = action.kind === "read" ? "Read" : action.title;
		text += `\n${theme.fg("dim", prefix)}${theme.fg("accent", title)} ${renderActionBody(action, theme, "muted")}`;
	}
	return text;
}

export function renderExplorationCall(
	action: ExplorationAction,
	theme: ExplorationRenderTheme,
	context:
		| {
				toolCallId?: string;
				invalidate?: () => void;
				isPartial?: boolean;
				isError?: boolean;
				executionStarted?: boolean;
		  }
		| undefined,
): string {
	registerExplorationRenderContext(context?.toolCallId, context?.invalidate);
	if (
		context?.executionStarted === false &&
		context.isPartial !== false &&
		context.toolCallId &&
		!entriesByToolCallId.has(context.toolCallId)
	)
		return "";
	const fallbackStatus = context?.isPartial === false ? "done" : "running";
	const renderInfo = getExplorationRenderInfo(context?.toolCallId, fallbackStatus);
	if (renderInfo.hidden) return "";
	return renderExplorationText(
		renderInfo.actionGroups ?? [[action]],
		renderInfo.status,
		theme,
		context?.isError === true,
	);
}

export function isExplorationHidden(toolCallId: string | undefined): boolean {
	return getExplorationRenderInfo(toolCallId, "done").hidden;
}

function recordExplorationStart(toolCallId: string, action: ExplorationAction): void {
	const entry: ExplorationEntry = {
		toolCallId,
		action,
		status: "running",
		hidden: false,
		invalidate: pendingInvalidatesByToolCallId.get(toolCallId),
	};
	pendingInvalidatesByToolCallId.delete(toolCallId);
	entriesByToolCallId.set(toolCallId, entry);

	let group = activeExplorationGroupId ? groupsById.get(activeExplorationGroupId) : undefined;
	if (group) {
		const previous = entriesByToolCallId.get(group.entryIds.at(-1) ?? "");
		const previousTarget = previous?.action.kind === "read" ? previous.action.renderTarget : previous?.action.kind;
		const nextTarget = action.kind === "read" ? action.renderTarget : action.kind;
		if (previous && previousTarget !== nextTarget) {
			activeExplorationGroupId = undefined;
			group = undefined;
		}
	}
	if (!group) {
		group = {
			id: nextGroupId++,
			entryIds: [toolCallId],
			visibleEntryId: toolCallId,
		};
		groupsById.set(group.id, group);
		activeExplorationGroupId = group.id;
		entry.groupId = group.id;
		return;
	}

	const previousVisibleEntry = entriesByToolCallId.get(group.visibleEntryId);
	if (previousVisibleEntry) {
		previousVisibleEntry.hidden = true;
		previousVisibleEntry.invalidate?.();
	}

	group.entryIds.push(toolCallId);
	group.visibleEntryId = toolCallId;
	entry.groupId = group.id;
	entry.invalidate?.();
}

function recordExplorationEnd(toolCallId: string): void {
	const entry = entriesByToolCallId.get(toolCallId);
	if (!entry) return;
	entry.status = "done";
	const group = getGroupForEntry(entry);
	entriesByToolCallId.get(group?.visibleEntryId ?? toolCallId)?.invalidate?.();
}

function resetExplorationGroup(): void {
	activeExplorationGroupId = undefined;
}

function clearExplorationGroup(): void {
	entriesByToolCallId.clear();
	summariesByToolCallId.clear();
	pendingInvalidatesByToolCallId.clear();
	groupsById.clear();
	activeExplorationGroupId = undefined;
	nextGroupId = 1;
}

function getGroupForEntry(entry: ExplorationEntry | undefined): ExplorationGroup | undefined {
	if (!entry?.groupId) return undefined;
	return groupsById.get(entry.groupId);
}

function renderStatusMarker(
	marker: string,
	status: ExplorationStatus,
	theme: Pick<ExplorationRenderTheme, "fg">,
	failed: boolean,
): string {
	if (status === "running") return theme.fg("dim", marker);
	return theme.fg(failed ? "error" : "success", marker);
}

function coalesceReadActions(actions: ExplorationAction[]): ExplorationAction[] {
	const coalesced: ExplorationAction[] = [];
	for (let index = 0; index < actions.length; index += 1) {
		const action = actions[index];
		if (action.kind !== "read") {
			coalesced.push(action);
			continue;
		}

		const reads: Extract<ExplorationAction, { kind: "read" }>[] = [];
		const seenPaths = new Set<string>();
		for (let readIndex = index; readIndex < actions.length; readIndex += 1) {
			const read = actions[readIndex];
			if (read.kind !== "read") break;
			const key = read.path ?? read.body;
			if (!seenPaths.has(key)) {
				reads.push(read);
				seenPaths.add(key);
			}
			index = readIndex;
		}

		const duplicateBodies = new Set<string>();
		const seenBodies = new Set<string>();
		for (const read of reads) {
			if (seenBodies.has(read.body)) duplicateBodies.add(read.body);
			seenBodies.add(read.body);
		}
		coalesced.push({
			kind: "read",
			body: reads.map((read) => (duplicateBodies.has(read.body) ? (read.path ?? read.body) : read.body)).join(", "),
			path: reads.at(-1)?.path,
			renderTarget: reads.at(-1)?.renderTarget ?? "read:file",
		});
	}
	return coalesced;
}

function isToolCallOnlyAssistantMessage(message: unknown): boolean {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return false;
	if (!("content" in message) || !Array.isArray(message.content) || message.content.length === 0) return false;
	return message.content.every(
		(item) => typeof item === "object" && item !== null && "type" in item && item.type === "toolCall",
	);
}
