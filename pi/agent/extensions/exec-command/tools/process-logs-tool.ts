import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { darkerCardBackgroundAnsi, framedBlock, renderStatusLine, textComponent } from "../../shared/tui/card";
import type { ExecSessionManager } from "./exec-session-manager.ts";

const PROCESS_LOGS_PARAMETERS = Type.Object({
	process: Type.Optional(
		Type.Union([Type.Number(), Type.String()], { description: "Managed process ID or stable name." }),
	),
	process_id: Type.Optional(Type.Number({ description: "Managed process ID. Prefer process." })),
	cursor: Type.Optional(Type.Number({ minimum: 0, description: "Absolute log cursor. Defaults to 0." })),
	max_chars: Type.Optional(
		Type.Number({ minimum: 1, maximum: 64 * 1024, description: "Maximum characters to return. Defaults to 64 KiB." }),
	),
});

interface ProcessLogsParams {
	process?: number | string;
	process_id?: number;
	cursor?: number;
	max_chars?: number;
}

function selector(params: ProcessLogsParams): number | string {
	if (typeof params.process === "number" || typeof params.process === "string") return params.process;
	if (typeof params.process_id === "number") return params.process_id;
	throw new Error("process_logs requires a process ID or name");
}
function sanitizeProcessOutput(value: string): string {
	return value
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function registerProcessLogsTool(pi: ExtensionAPI, sessions: ExecSessionManager): void {
	pi.registerTool({
		name: "process_logs",
		label: "process_logs",
		description: "Reads append-only output from a managed exec process using an absolute cursor.",
		promptSnippet: "Read new output from an exec process.",
		parameters: PROCESS_LOGS_PARAMETERS,
		renderShell: "self",
		renderCall(args, theme, context) {
			if (context.isPartial !== true) return textComponent("");
			const input = args ?? {};
			const process =
				typeof input.process === "string" || typeof input.process === "number"
					? String(input.process)
					: typeof input.process_id === "number"
						? String(input.process_id)
						: undefined;
			return framedBlock(theme, {
				header: renderStatusLine(theme, { icon: "pending", title: "Read process logs", description: process }),
				borderColor: "accent",
				backgroundAnsi: darkerCardBackgroundAnsi(theme, "toolPendingBg"),
			});
		},
		renderResult(result, { expanded }, theme, context) {
			const details = (result.details ?? {}) as {
				process_id?: number;
				running?: boolean;
				cursor?: number;
				next_cursor?: number;
				truncated?: boolean;
				output?: string;
			};
			const rawOutput =
				details.output ??
				result.content
					?.filter((part) => part.type === "text" && typeof part.text === "string")
					.map((part) => part.text)
					.join("\n") ??
				"";
			const output = sanitizeProcessOutput(rawOutput).trimEnd();
			const lines = output ? (expanded ? output.split(/\r?\n/) : output.split(/\r?\n/).slice(-8)) : [];
			return framedBlock(theme, {
				header: renderStatusLine(theme, {
					icon: context.isError ? "error" : "success",
					title: "Process logs",
					description: details.process_id === undefined ? undefined : `#${details.process_id}`,
					meta: [
						details.running ? "running" : "exited",
						`cursor ${details.cursor ?? 0}-${details.next_cursor ?? 0}`,
						...(details.truncated ? ["earlier output omitted"] : []),
					],
				}),
				sections: [{ lines: lines.length ? lines : [theme.fg("muted", "No new output.")] }],
				borderColor: context.isError ? "error" : "borderMuted",
				backgroundAnsi: darkerCardBackgroundAnsi(theme, context.isError ? "toolErrorBg" : "toolPendingBg"),
			});
		},
		async execute(_toolCallId, params) {
			const typed = params as ProcessLogsParams;
			const process = selector(typed);
			const chunk = sessions.logs(process, typed.cursor, typed.max_chars);
			if (!chunk) throw new Error(`Unknown process ${process}`);
			const status = chunk.running ? "running" : "exited";
			const header = `Process ${chunk.process_id} ${status} · cursor ${chunk.cursor}-${chunk.next_cursor}${chunk.truncated ? " · earlier output omitted" : ""}`;
			return {
				content: [{ type: "text", text: chunk.output ? `${header}\n\n${chunk.output}` : header }],
				details: chunk,
			};
		},
	});
}
