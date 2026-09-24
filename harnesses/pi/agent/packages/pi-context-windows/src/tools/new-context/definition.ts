import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ContextWindows } from "../../runtime/windows.ts";
import { registerContextTool } from "../register.ts";
import { contextResult } from "../result.ts";
export function registerWindowTools(pi: ExtensionAPI, windows: ContextWindows): (() => void)[] {
	return [
		registerContextTool(
			pi,
			"new_context",
			"Start a new context window after this tool batch completes. Save progress in notes first. Does not reset the session, tools, processes, or workspace.",
			Type.Object({}),
			async (_args, ctx) => {
				windows.request(ctx);
				return contextResult("new_context", {}, { accepted: true });
			},
			false,
		),
		registerContextTool(
			pi,
			"get_context_remaining",
			"Get the remaining tokens in the current context window. tokens_left is null until trustworthy usage is available.",
			Type.Object({}),
			async (_args, ctx) => contextResult("get_context_remaining", {}, { tokens_left: windows.remaining(ctx) }),
		),
	];
}
