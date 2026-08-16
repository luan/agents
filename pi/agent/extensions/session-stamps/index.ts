import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { takeReadObservation } from "../shared/read-observations.ts";
import { getRegisteredTool } from "../shared/tool-registry.ts";
import { type BuildStamp, computeBuildStamp } from "./hash.ts";

const BUILD_ENTRY = "build_stamp";
const READ_ENTRY = "read_selector";
const WRAPPED = Symbol.for("agents.sessionStamps.wrapped");

type TextPart = { type: string; text?: string };
type ToolResultLike = { content?: TextPart[]; isError?: boolean };

// `appendCustomEntry` writes `type: "custom"`; sessionEntryToContextMessages (session-manager.js:166) has no branch
// for it and falls through to `return []`. Record, never shown.
type WritableSessionManager = ExtensionContext["sessionManager"] & {
	appendCustomEntry(customType: string, data?: unknown): string;
};

function append(ctx: unknown, customType: string, data: unknown): void {
	const manager = (ctx as { sessionManager?: Partial<WritableSessionManager> } | undefined)?.sessionManager;
	if (typeof manager?.appendCustomEntry !== "function") return;
	try {
		manager.appendCustomEntry(customType, data);
	} catch {
		// Telemetry must not turn a successful read into a failed tool call.
	}
}

function returnedLines(result: ToolResultLike | undefined): number {
	let lines = 0;
	for (const part of result?.content ?? []) {
		if (part.type !== "text" || !part.text) continue;
		lines += part.text.split("\n").length;
	}
	return lines;
}

/** Consumes the observation, so whichever seam fires first for a call is the only one that records it. */
function recordRead(ctx: unknown, toolCallId: unknown, result: ToolResultLike | undefined): void {
	if (typeof toolCallId !== "string") return;
	const observed = takeReadObservation(toolCallId);
	if (!observed) return;
	append(ctx, READ_ENTRY, {
		sel: observed.sel,
		ret: returnedLines(result),
		...(observed.tot === undefined ? {} : { tot: observed.tot }),
	});
}

export default function sessionStampsExtension(pi: ExtensionAPI) {
	// One stamp per boot, not per session: an edit made after boot must not change what a running session reports.
	let stamp: BuildStamp | undefined;
	let stamped: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		stamp ??= computeBuildStamp();
		const sessionFile = ctx.sessionManager.getSessionFile?.() ?? undefined;
		if (stamped !== sessionFile) {
			stamped = sessionFile;
			append(ctx, BUILD_ENTRY, stamp);
		}
		// Seam 1 — a code-mode cell calls the registry definition directly and never raises `tool_result`.
		// Waits for session_start because extension load order does not guarantee fileops registered `read` yet.
		const tool = getRegisteredTool("read", ctx.sessionManager.getSessionId()) as
			| (Record<symbol | string, unknown> & { execute?: unknown })
			| undefined;
		if (!tool || typeof tool.execute !== "function" || tool[WRAPPED]) return;
		const original = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
		tool.execute = async (...args: unknown[]): Promise<ToolResultLike> => {
			const result = await original(...args);
			recordRead(args[4], args[0], result);
			return result;
		};
		tool[WRAPPED] = true;
	});

	// Seam 2 — the Direct tool surface can still hold the pre-wrap `execute` (wrapper.js:14 captures it on refresh).
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "read") return;
		recordRead(ctx, event.toolCallId, { content: event.content, isError: event.isError });
	});
}
