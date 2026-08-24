import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCodeModeFunctionTool } from "pi-code-mode/sdk";
import registerNativeCompaction from "./compaction/index.ts";
import registerContextWindow from "./context-window.ts";
import { registerCodexNativeXSettings } from "./contributions/xsettings.ts";
import { type CodexDiagnosticsController, createCodexDiagnosticsController } from "./diagnostics/controller.ts";
import registerFastMode from "./fast-mode.ts";
import { registerCodexPromptPayloadAdapter } from "./prompt-payload-adapter.ts";
import { registerOpenAICodexProvider } from "./provider/provider.ts";
import type { CodexProviderRuntime } from "./provider/runtime.ts";
import { registerTextVerbosity } from "./provider/text-verbosity.ts";
import { createWebRunTool } from "./tools/web-run/definition.ts";

function reportDiagnosticsFailure(ctx: ExtensionContext, action: string, error: unknown): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.notify(
			`Codex cache diagnostics could not ${action}: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	} catch {
		// Optional diagnostics must not affect provider lifecycle.
	}
}

export function registerCodexNativeLifecycle(
	pi: Pick<ExtensionAPI, "on">,
	runtime: Pick<CodexProviderRuntime, "startSession" | "selectModel" | "shutdownSession">,
	diagnostics: CodexDiagnosticsController,
): { settingsChanged(): Promise<void> } {
	let currentContext: ExtensionContext | undefined;
	const configureDiagnostics = async (ctx: ExtensionContext, action: string): Promise<void> => {
		try {
			await diagnostics.configure(ctx);
		} catch (error) {
			reportDiagnosticsFailure(ctx, action, error);
		}
	};
	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		runtime.startSession(ctx);
		await configureDiagnostics(ctx, "start");
	});
	pi.on("model_select", async (_event, ctx) => {
		currentContext = ctx;
		runtime.selectModel(ctx);
		await configureDiagnostics(ctx, "reconfigure");
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		currentContext = undefined;
		try {
			await diagnostics.shutdown();
		} catch (error) {
			reportDiagnosticsFailure(ctx, "stop", error);
		} finally {
			runtime.shutdownSession(ctx);
		}
	});
	return {
		async settingsChanged() {
			if (currentContext) await configureDiagnostics(currentContext, "reconfigure");
		},
	};
}

export default function codexNativeExtension(pi: ExtensionAPI): void {
	const unregisterPromptPayloadAdapter = registerCodexPromptPayloadAdapter();
	const webRunTool = createWebRunTool();
	const unregisterCodeModeWebRun = registerCodeModeFunctionTool(webRunTool);
	const runtime = registerOpenAICodexProvider(pi);
	const diagnostics = createCodexDiagnosticsController(runtime);
	pi.registerTool(webRunTool);
	const contextWindow = registerContextWindow(pi);
	registerNativeCompaction(pi, {
		resetTransportAfterCompaction: (sessionId) => runtime.resetTransportAfterCompaction(sessionId),
		startCompactionPrewarm: (input) => runtime.startCompactionPrewarm(input),
	});
	const fastMode = registerFastMode(pi);
	registerTextVerbosity(pi);
	const lifecycle = registerCodexNativeLifecycle(pi, runtime, diagnostics);
	const unregisterXSettings = registerCodexNativeXSettings(async (settings) => {
		fastMode.settingsChanged(settings);
		await contextWindow.settingsChanged(settings);
		await lifecycle.settingsChanged();
	});
	pi.on("session_shutdown", (event) => {
		if (event.reason !== "reload" && event.reason !== "quit") return;
		unregisterPromptPayloadAdapter();
		unregisterCodeModeWebRun();
		fastMode.dispose();
		contextWindow.dispose();
		unregisterXSettings();
	});
}
