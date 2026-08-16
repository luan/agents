import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	readAction,
	registerExplorationEventHandlers,
	registerExplorationTool,
} from "../shared/exploration-rendering.ts";
import { type RegisteredToolDefinition, toolRegistrarFor } from "../shared/tool-registry.ts";
import { registerToolResultImageRestore } from "../shared/tool-result-images.ts";
import { markLiveTurnStarted } from "../shared/tui";
import {
	APPLY_PATCH_GRAMMAR,
	type EditMode,
	getEditFreeformToolConfig,
	getEditMode,
	HASHLINE_GRAMMAR,
	loadConfig,
	REPLACE_GRAMMAR,
	setEditMode,
	summarizeResource,
} from "./execution.ts";
import {
	deleteHashlineSnapshotStoreForSession,
	FALLBACK_HASHLINE_SNAPSHOT_SESSION_ID,
	hashlineSnapshotStoreForSession,
	restoreHashlineSnapshots,
} from "./hashline/anchors.js";
import {
	createFileopsPresentation,
	isGatedFileopsTool,
	nestedFileopsCallIds,
	shortenDisplayPath,
} from "./presentation.ts";
import { registerAstTools, registerEditTool, registerHashlineWorkflowTools } from "./runtime.ts";

export {
	APPLY_PATCH_GRAMMAR,
	type EditMode,
	getEditFreeformToolConfig,
	getEditMode,
	HASHLINE_GRAMMAR,
	REPLACE_GRAMMAR,
	setEditMode,
	shortenDisplayPath,
	summarizeResource,
};

function sessionIdFromContext(ctx: Pick<ExtensionContext, "sessionManager"> | undefined): string | undefined {
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

export default function fileopsExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	const fallbackSnapshots = hashlineSnapshotStoreForSession(FALLBACK_HASHLINE_SNAPSHOT_SESSION_ID);
	const snapshotsForContext = (ctx: Pick<ExtensionContext, "sessionManager"> | undefined) => {
		const sessionId = sessionIdFromContext(ctx);
		return sessionId ? hashlineSnapshotStoreForSession(sessionId) : fallbackSnapshots;
	};

	let currentTurnIndex: number | undefined;
	const latestTurnToolCallIds = new Set<string>();
	const markToolCall = (toolCallId: string) => latestTurnToolCallIds.add(toolCallId);
	const resetTurnTracking = () => {
		currentTurnIndex = undefined;
		latestTurnToolCallIds.clear();
	};
	const rebuildVisibleFileopsWindow = (ctx: ExtensionContext | undefined) => {
		latestTurnToolCallIds.clear();
		const branch = ctx?.sessionManager?.getBranch?.() ?? [];
		const latestCompactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
		const latestCompaction = latestCompactionIndex === -1 ? undefined : branch[latestCompactionIndex];
		const firstKeptEntryId = latestCompaction?.type === "compaction" ? latestCompaction.firstKeptEntryId : undefined;
		const firstVisibleIndex =
			typeof firstKeptEntryId === "string"
				? Math.max(
						0,
						branch.findIndex((entry) => entry.id === firstKeptEntryId),
					)
				: 0;
		for (const entry of branch.slice(firstVisibleIndex)) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "toolResult") {
				for (const id of nestedFileopsCallIds(entry.message)) latestTurnToolCallIds.add(id);
				continue;
			}
			if (entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (
					block?.type === "toolCall" &&
					isGatedFileopsTool(block.name) &&
					typeof block.id === "string" &&
					block.id.length > 0
				) {
					latestTurnToolCallIds.add(block.id);
				}
			}
		}
	};

	pi.on?.("turn_start", () => markLiveTurnStarted());
	registerToolResultImageRestore(pi);
	registerExplorationTool("read", (args) =>
		readAction(typeof args === "object" && args && "path" in args ? String(args.path) : ""),
	);
	registerExplorationEventHandlers(pi);

	const on = (pi as Partial<ExtensionAPI>).on;
	if (typeof on === "function") {
		on.call(pi, "session_start", async (_event, ctx) => {
			resetTurnTracking();
			rebuildVisibleFileopsWindow(ctx);
			const sessionId = sessionIdFromContext(ctx);
			if (sessionId) {
				await restoreHashlineSnapshots(
					hashlineSnapshotStoreForSession(sessionId),
					ctx.cwd,
					ctx.sessionManager?.getBranch?.() ?? [],
				);
			}
		});
		on.call(pi, "session_shutdown", (_event, ctx) => {
			const sessionId = sessionIdFromContext(ctx);
			if (sessionId) deleteHashlineSnapshotStoreForSession(sessionId);
		});
		on.call(pi, "session_tree", (_event, ctx) => {
			resetTurnTracking();
			rebuildVisibleFileopsWindow(ctx);
		});
		on.call(pi, "session_compact", (_event, ctx) => rebuildVisibleFileopsWindow(ctx));
		on.call(pi, "turn_start", (event) => {
			currentTurnIndex = event.turnIndex;
		});
		on.call(pi, "tool_execution_start", (event) => {
			if (isGatedFileopsTool(event.toolName)) markToolCall(event.toolCallId);
		});
	}

	const renderTracking = {
		latestTurnToolCallIds,
		markToolCall,
		getLatestTurnIndex: () => currentTurnIndex,
	};
	const present = createFileopsPresentation(() => config, renderTracking);
	const registerTool = toolRegistrarFor(pi);
	const registerFileopsTool = (definition: unknown) =>
		registerTool(present(definition as RegisteredToolDefinition) as never);
	registerEditTool(registerFileopsTool, () => config, snapshotsForContext, renderTracking);
	registerHashlineWorkflowTools(registerFileopsTool, () => config, snapshotsForContext, renderTracking);
	registerAstTools(registerFileopsTool, snapshotsForContext);
}
