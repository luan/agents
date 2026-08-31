import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function subagentSessionRoot(context: ExtensionContext): string {
	if (context.sessionManager.getSessionFile()) return context.sessionManager.getSessionDir();
	return join(tmpdir(), "pi-subagents", context.sessionManager.getSessionId());
}
