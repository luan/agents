import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CodexProviderRuntime } from "../provider/runtime.ts";
import type { CodexDiagnosticsSink } from "../provider/types.ts";
import {
	type CacheDiagnosticsMode,
	type CodexNativeSettings,
	getCodexNativeSettings,
} from "../contributions/xsettings.ts";
import { createCodexDiagnosticsStatus, type CodexDiagnosticsStatus } from "./status.ts";

interface ActiveDiagnostics {
	key: string;
	runtime: CodexDiagnosticsStatus;
	sink: CodexDiagnosticsSink;
}

export interface CodexDiagnosticsController {
	configure(ctx: ExtensionContext): Promise<void>;
	shutdown(): Promise<void>;
}

export function createCodexDiagnosticsController(
	provider: Pick<CodexProviderRuntime, "registerDiagnostics">,
	options: {
		agentDir?: string;
		getSettings?: () => CodexNativeSettings;
		createStatus?: typeof createCodexDiagnosticsStatus;
		missHoldMs?: number;
	} = {},
): CodexDiagnosticsController {
	const agentDir = options.agentDir ?? getAgentDir();
	const getSettings = options.getSettings ?? getCodexNativeSettings;
	const createStatus = options.createStatus ?? createCodexDiagnosticsStatus;
	let active: ActiveDiagnostics | undefined;
	let unsubscribe: (() => void) | undefined;
	let stopInFlight: Promise<void> | undefined;
	let activeGeneration = 0;

	const ensureSubscription = () => {
		if (unsubscribe) return;
		unsubscribe = provider.registerDiagnostics((event) => active?.sink(event));
	};
	const stopActive = (): Promise<void> => {
		const previous = active;
		active = undefined;
		if (!previous) return stopInFlight ?? Promise.resolve();
		const current = (stopInFlight ?? Promise.resolve()).catch(() => undefined).then(() => previous.runtime.shutdown());
		stopInFlight = current;
		void current
			.finally(() => {
				if (stopInFlight === current) stopInFlight = undefined;
			})
			.catch(() => undefined);
		return current;
	};
	const safeNotify = (ctx: ExtensionContext, message: string) => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.notify(message, "warning");
		} catch {
			// Diagnostics failures must not affect provider execution.
		}
	};
	const stopForReconfigure = async (ctx: ExtensionContext) => {
		try {
			await stopActive();
		} catch (error) {
			safeNotify(
				ctx,
				`Could not close the previous Codex cache log: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
	const configureMode = async (ctx: ExtensionContext, mode: CacheDiagnosticsMode) => {
		const model = ctx.model;
		const enabled = mode !== "off" && model?.provider === "openai-codex";
		const key = JSON.stringify([
			mode,
			ctx.sessionManager.getSessionId(),
			model?.provider,
			model?.id,
			model?.api,
			model?.baseUrl,
		]);
		if (enabled && active?.key === key) return;
		const currentGeneration = ++activeGeneration;
		if (!enabled) {
			await stopForReconfigure(ctx);
			return;
		}
		await stopForReconfigure(ctx);
		if (activeGeneration !== currentGeneration) return;
		const next = await createStatus({
			mode,
			ctx,
			agentDir,
			missHoldMs: options.missHoldMs,
		});
		if (activeGeneration !== currentGeneration) {
			await next.shutdown();
			return;
		}
		let sinkFailed = false;
		const sink: CodexDiagnosticsSink = (event) => {
			if (sinkFailed || activeGeneration !== currentGeneration || active?.runtime !== next) return;
			try {
				next.record(event);
			} catch (error) {
				sinkFailed = true;
				safeNotify(ctx, `Codex cache diagnostics stopped: ${error instanceof Error ? error.message : String(error)}`);
			}
		};
		active = { key, runtime: next, sink };
	};

	return {
		async configure(ctx) {
			ensureSubscription();
			const settings = getSettings();
			await configureMode(ctx, settings.cacheDiagnostics);
		},
		async shutdown() {
			activeGeneration++;
			const stop = stopActive();
			unsubscribe?.();
			unsubscribe = undefined;
			await stop;
		},
	};
}
