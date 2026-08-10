import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { invokeCoreSync } from "./core.js";
import { setCurrentContextGuardSessionId } from "./current-session.js";
import { markExecCommandContextGuardEnabled } from "./index.js";
import { getStorePath } from "./tool-paths.js";
import { registerPiContextTools } from "./tools.js";

const PI_WORKSPACE_ENV_VARS = ["PI_WORKSPACE_DIR", "PI_PROJECT_DIR"] as const;
let sessionId = "";

function deriveSessionId(ctx: Record<string, unknown>): string {
	try {
		const sessionManager = ctx.sessionManager as { getSessionFile?: () => string } | undefined;
		const sessionFile = sessionManager?.getSessionFile?.();
		if (sessionFile) return createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
	} catch {
		// A stable file-backed ID is preferred; timestamp fallback remains session-local.
	}
	return `pi-${Date.now()}`;
}

function buildStatusText(projectDir: string): string {
	const response = invokeCoreSync("status", { dbPath: getStorePath(projectDir) });
	return response.content[0]?.text ?? "context-guard status unavailable";
}

function commandContext(argsOrCtx: unknown, ctx: unknown): any {
	if (ctx !== undefined) return ctx;
	return argsOrCtx && typeof argsOrCtx === "object" ? argsOrCtx : undefined;
}

export function resolvePiWorkspaceDir(opts: {
	env: Record<string, string | undefined>;
	pwd: string | undefined;
	cwd: string;
	home?: string;
}): string {
	const home = opts.home ?? homedir();
	const piConfigDir = join(home, ".pi");
	const isPiConfigPath = (path: string | undefined): boolean =>
		!path || path === piConfigDir || path.startsWith(`${piConfigDir}/`) || path.startsWith(`${piConfigDir}\\`);
	for (const candidate of [...PI_WORKSPACE_ENV_VARS.map((name) => opts.env[name]), opts.pwd, opts.cwd]) {
		if (!isPiConfigPath(candidate)) return candidate!;
	}
	return home;
}

export default function piExtension(pi: any): void {
	markExecCommandContextGuardEnabled();
	const projectDir = resolvePiWorkspaceDir({
		env: process.env,
		pwd: process.env.PWD,
		cwd: process.cwd(),
	});

	pi.on("session_start", (_event: unknown, ctx: Record<string, unknown>) => {
		sessionId = deriveSessionId(ctx ?? {});
		setCurrentContextGuardSessionId(sessionId);
	});

	pi.on("session_shutdown", () => {
		sessionId = "";
		setCurrentContextGuardSessionId(undefined);
	});

	pi.registerCommand("cg-status", {
		description: "Show Context Guard capture and storage status",
		handler: (argsOrCtx: unknown, maybeCtx: unknown) => {
			const text = buildStatusText(projectDir);
			const ctx = commandContext(argsOrCtx, maybeCtx);
			if (ctx?.hasUI) {
				ctx.ui.notify(text, "info");
				return;
			}
			return { text };
		},
	});

	registerPiContextTools(pi);
}
