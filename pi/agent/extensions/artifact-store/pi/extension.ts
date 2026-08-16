import { createArtifactResourceProvider } from "../../shared/artifact-resources.ts";
import { artifactStoreFor } from "../../shared/artifact-store.ts";
import { registerResourceProvider } from "../../shared/resources.ts";
import { sessionIdFromContext } from "../../shared/session-context.ts";
import { setArtifactMinter } from "../../shared/tool-bounding.ts";
import {
	clearCurrentArtifactSession,
	getCurrentArtifactSession,
	setCurrentArtifactSession,
} from "./current-session.js";
import { markExecCaptureEnabled } from "./index.js";

// The minter outlives any one session, so the session is read per call: an artifact filed under a stale session is unfindable from the one that produced it.
// `label` becomes the middle segment of the filename, so a listing of the directory reads as a log of what spilled.
async function mintArtifact(
	text: string,
	label: string,
	existingUri?: string,
	ownerSessionId?: string,
): Promise<string | undefined> {
	const store = artifactStoreFor(getCurrentArtifactSession(ownerSessionId));
	if (existingUri) {
		const id = /^artifact:\/\/(\d+)$/.exec(existingUri)?.[1];
		if (id && (await store.replace(id, text))) return existingUri;
	}
	const id = await store.mint(text, label);
	return id ? `artifact://${id}` : undefined;
}

function commandContext(argsOrCtx: unknown, ctx: unknown): any {
	if (ctx !== undefined) return ctx;
	return argsOrCtx && typeof argsOrCtx === "object" ? argsOrCtx : undefined;
}

async function buildStatusText(sessionId?: string): Promise<string> {
	const session = getCurrentArtifactSession(sessionId);
	const store = artifactStoreFor(session);
	if (!store.dir) return "Artifacts: in memory (session has no file on disk)";
	const ids = await store.listIds();
	const range = ids.length > 0 ? `${ids.length} artifact(s), ids ${ids[0]}–${ids.at(-1)}` : "no artifacts yet";
	return `Artifacts: ${store.dir}\n${range}`;
}

export default function piExtension(pi: any): void {
	let sessionId: string | undefined;
	markExecCaptureEnabled();
	registerResourceProvider("artifact", createArtifactResourceProvider(getCurrentArtifactSession));
	setArtifactMinter(mintArtifact);

	pi.on("session_start", (_event: unknown, ctx: Record<string, unknown>) => {
		const sessionManager = ctx?.sessionManager as
			| { getSessionFile?: () => string; getSessionId?: () => string }
			| undefined;
		sessionId = sessionManager?.getSessionId?.();
		setCurrentArtifactSession(
			{
				sessionFile: sessionManager?.getSessionFile?.(),
				sessionId,
			},
			sessionId,
		);
	});

	pi.on("session_shutdown", (_event: unknown, ctx: unknown) => {
		const shutdownSessionId = sessionIdFromContext(ctx) ?? sessionId;
		clearCurrentArtifactSession(shutdownSessionId);
		if (shutdownSessionId === sessionId) sessionId = undefined;
	});

	pi.registerCommand("artifacts", {
		description: "Show where this session's artifacts are stored and how many there are",
		handler: async (argsOrCtx: unknown, maybeCtx: unknown) => {
			const text = await buildStatusText(sessionId);
			const ctx = commandContext(argsOrCtx, maybeCtx);
			if (ctx?.hasUI) {
				ctx.ui.notify(text, "info");
				return;
			}
			return { text };
		},
	});
}
