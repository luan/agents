import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { invalidPayloadResponse, nonInteractiveResponse, successfulResponse, validateParams } from "./ask-tool-helpers";
import type { AskParams } from "./types";
import { runAskFlow } from "./ui/controller";

export async function executeAskTool(pi: ExtensionAPI, params: AskParams, ctx: ExtensionContext) {
	const validation = validateParams(params);
	if (!validation.ok) {
		return invalidPayloadResponse(params, validation.issues);
	}
	if (!ctx.hasUI) {
		return nonInteractiveResponse(validation.state);
	}
	pi.events.emit("ask:waiting:start", undefined);
	try {
		const result = await runAskFlow(ctx, params);
		return successfulResponse(result);
	} finally {
		pi.events.emit("ask:waiting:end", undefined);
	}
}
