import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * The session key a checkpoint and a journal are stored under.
 *
 * A restart or a reset appends a new epoch entry, so the old checkpoint stays on disk but is no
 * longer addressed. `checkpoint.ts` collects superseded epochs of the same session id.
 */

export const NOTEBOOK_TREE_EPOCH_ENTRY = "code-mode-notebook-tree-epoch";

export function appendNotebookTreeEpoch(pi: ExtensionAPI): void {
	pi.appendEntry(NOTEBOOK_TREE_EPOCH_ENTRY, { epoch: randomUUID() });
}

export function notebookSessionIdentity(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (
			entry?.type !== "custom" ||
			entry.customType !== NOTEBOOK_TREE_EPOCH_ENTRY ||
			!entry.data ||
			typeof entry.data !== "object" ||
			!("epoch" in entry.data) ||
			typeof entry.data.epoch !== "string"
		) {
			continue;
		}
		return `${ctx.sessionManager.getSessionId()}\0${entry.data.epoch}`;
	}
	return `${ctx.sessionManager.getSessionId()}\0root`;
}
