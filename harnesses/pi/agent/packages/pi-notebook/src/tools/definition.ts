import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Image, Text } from "@earendil-works/pi-tui";
import { ComponentStack, tuiTheme } from "@luan.sh/pi-libtui";
import { ToolActivity, settleToolCallPreview, toolCallPreview } from "@luan.sh/pi-libtui/tool";
import type { NotebookClient, JsonValue } from "../runtime/client.ts";
const codeParameters = Type.Object({ code: Type.String({ minLength: 1, maxLength: 1_000_000 }) });
const controlParameters = Type.Object({
	action: StringEnum(["checkpoint", "restart", "reset", "status", "save_profile", "load_profile"] as const),
	name: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{1,80}$" })),
});
export interface NotebookDetails {
	version: 1;
	tool: "notebook";
	status: "succeeded" | "failed";
	text: string;
}
function result(value: JsonValue): AgentToolResult<NotebookDetails> {
	const content: AgentToolResult<NotebookDetails>["content"] = [];
	let failed = false;
	if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.output)) {
		for (const item of value.output) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			if (item.type === "error") failed = true;
			if (typeof item.text === "string")
				content.push({ type: "text", text: item.type === "error" ? `Error: ${item.text}` : item.text });
			if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string")
				content.push({ type: "image", data: item.data, mimeType: item.mimeType });
		}
		const checkpoint = value.checkpoint;
		if (
			checkpoint &&
			typeof checkpoint === "object" &&
			!Array.isArray(checkpoint) &&
			(checkpoint.saved === false || (Array.isArray(checkpoint.skipped) && checkpoint.skipped.length))
		)
			content.push({ type: "text", text: `Checkpoint: ${JSON.stringify(checkpoint)}` });
	} else if (value && typeof value === "object" && !Array.isArray(value)) {
		if (typeof value.message === "string") content.push({ type: "text", text: value.message });
		if (Array.isArray(value.bindings))
			content.push({ type: "text", text: `Bindings: ${value.bindings.length ? value.bindings.join(", ") : "none"}` });
		if (Array.isArray(value.skipped) && value.skipped.length)
			content.push({ type: "text", text: `Skipped bindings: ${JSON.stringify(value.skipped)}` });
	} else content.push({ type: "text", text: JSON.stringify(value) });
	if (!content.length) content.push({ type: "text", text: "Cell completed." });
	return {
		content,
		details: {
			version: 1,
			tool: "notebook",
			status: failed ? "failed" : "succeeded",
			text: content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		},
	};
}
function presentation<T extends typeof codeParameters | typeof controlParameters>(): Pick<
	ToolDefinition<T, NotebookDetails>,
	"renderCall" | "renderResult" | "renderShell"
> {
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			if (context.executionStarted) return new ComponentStack();
			return toolCallPreview(
				context.state,
				new ToolActivity({
					theme,
					requestRender: context.invalidate,
					view: {
						action: { verb: "Run notebook", detail: "code" in args ? args.code : args.action, status: "queued" },
					},
				}),
			);
		},
		renderResult(result, options, theme, context) {
			settleToolCallPreview(context.state);
			const failed = context.isError || result.details?.status === "failed";
			const text =
				result.details?.text ??
				result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
			return ToolActivity.reuse(context.lastComponent, {
				theme,
				requestRender: context.invalidate,
				view: {
					action: { verb: failed ? "Notebook failed" : "Notebook completed", status: failed ? "failed" : "succeeded" },
					payload: {
						kind: "component",
						preview: new ComponentStack([
							new Text(text, 0, 0),
							...(context.showImages ? result.content.filter((part) => part.type === "image") : []).map(
								(part) =>
									new Image(
										part.data,
										part.mimeType,
										{ fallbackColor: (value) => tuiTheme(theme).fg("text.muted", value) },
										{ maxHeightCells: 16 },
									),
							),
						]),
					},
					mode: options.expanded ? "full" : "preview",
				},
			});
		},
	};
}
export function notebookTools(client: NotebookClient) {
	const execute: ToolDefinition<typeof codeParameters, NotebookDetails> = {
		name: "notebook__exec",
		label: "Notebook",
		parameters: codeParameters,
		description:
			"Execute JavaScript or TypeScript in a persistent Deno notebook. Top-level bindings survive cells. Supports Deno filesystem/network APIs and imports. Successful checkpoints restore serializable values after restart; functions, promises, and native handles are reported as skipped. This is separate from fresh-isolate Code Mode.",
		promptGuidelines: [
			"Use notebook__control to inspect, checkpoint, restart, reset, or save/load a profile. Do not replay cells to restore state: replay can repeat side effects. In Code Mode, text(result.text); forward result.images with image(image_url).",
		],
		...presentation<typeof codeParameters>(),
		async execute(_id, args, signal, _update, ctx) {
			return result(await client.execute({ operation: "execute", code: args.code }, ctx, signal));
		},
	};
	const control: ToolDefinition<typeof controlParameters, NotebookDetails> = {
		name: "notebook__control",
		label: "Notebook state",
		parameters: controlParameters,
		description:
			"Manage the persistent notebook. checkpoint saves values; restart restores the latest values; reset discards current bindings and checkpoint; status lists bindings; save_profile/load_profile store or replace bindings by value. Profiles belong to the current working directory and remain after reset. Supply name only for profiles.",
		...presentation<typeof controlParameters>(),
		async execute(_id, args, signal, _update, ctx) {
			const profile = args.action === "save_profile" || args.action === "load_profile";
			if (profile !== Boolean(args.name))
				throw new Error("Supply a profile name only for save_profile or load_profile");
			return result(
				await client.execute({ operation: args.action, ...(args.name ? { name: args.name } : {}) }, ctx, signal),
			);
		},
	};
	return { execute, control };
}
export function notebookResult(result: AgentToolResult<NotebookDetails>) {
	return {
		text: result.details.text,
		images: result.content
			.filter((part) => part.type === "image")
			.map((part) => `data:${part.mimeType};base64,${part.data}`),
	};
}
