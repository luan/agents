type ExplorationStatus = "running" | "done";

type ExplorationAction =
	| { kind: "read"; title?: string; body: string; path?: string }
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
const groupsById = new Map<number, ExplorationGroup>();
let activeExplorationGroupId: number | undefined;
let nextGroupId = 1;

export function readAction(filePath: string | undefined): ExplorationAction {
	const path = filePath ?? "";
	return { kind: "read", body: path || "file", path };
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
		let text = `${marker} ${theme.bold("Read")}${count}`;
		for (const [index, read] of reads.entries()) {
			const branch = index === reads.length - 1 ? "└─" : "├─";
			text += `\n${theme.fg("dim", `   ${branch} `)}${theme.fg("accent", read.body)}`;
		}
		return text;
	}

	const header = status === "running" ? "Exploring" : "Explored";
	let text = `${renderStatusMarker("•", status, theme, failed)} ${theme.bold(header)}`;
	for (const [index, action] of coalesceReadActions(actions).entries()) {
		const prefix = index === 0 ? "  └ " : "    ";
		const title = action.kind === "read" ? "Read" : action.title;
		text += `\n${theme.fg("dim", prefix)}${theme.fg("accent", title)} ${theme.fg("muted", action.body)}`;
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
