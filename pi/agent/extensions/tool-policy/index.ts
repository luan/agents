import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { registerCodeModeToolPreflight } from "../code-mode/nested-tool-preflight.ts";
import { runInSession, sessionIdFromContext } from "../shared/session-context.ts";
import { boundToolResultEvent } from "../shared/tool-bounding.ts";
import {
	createToolPolicy,
	hiddenToolReason,
	loadToolPolicyConfig,
	publishToolPolicy,
	unpublishToolPolicy,
} from "./policy.ts";

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json");

const extension: ExtensionFactory = (pi) => {
	const policy = createToolPolicy(pi, loadToolPolicyConfig(CONFIG_PATH), CONFIG_PATH);
	let sessionId: string | undefined;
	policy.install();
	registerCodeModeToolPreflight(pi, (call) =>
		policy.isHidden(call.toolName) ? { block: true, reason: hiddenToolReason(call.toolName) } : undefined,
	);
	pi.on("session_start", (_event, ctx) => {
		sessionId = sessionIdFromContext(ctx);
		publishToolPolicy(policy, sessionId);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const shutdownSessionId = sessionIdFromContext(ctx) ?? sessionId;
		unpublishToolPolicy(shutdownSessionId);
		if (shutdownSessionId === sessionId) sessionId = undefined;
	});
	pi.on(
		"tool_result",
		async (event, ctx) =>
			await runInSession(ctx, () => boundToolResultEvent({ ...event, ownerSessionId: sessionIdFromContext(ctx) })),
	);
};

export default extension;
