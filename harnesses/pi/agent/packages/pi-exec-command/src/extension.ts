import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveExecCommandBinary } from "./binary.ts";
import { registerCodeModeExecAdapters } from "./code-mode-adapters.ts";
import { openRegisteredProcessHub, registerProcessHubHost, retainProcessHubAction } from "./contributions/actions.ts";
import { createExecSessionManager, type ExecSessionManager } from "./session-manager.ts";
import { createExecCommandTool } from "./tools/exec-command/definition.ts";
import type { ExecRuntime } from "./tools/runtime.ts";
import { createWriteStdinTool } from "./tools/write-stdin/definition.ts";
import { openProcessHub } from "./ui/process-hub.ts";
import { ProcessWidget } from "./ui/process-widget.ts";
import {
	ProcessTerminalStore,
	supportsProcessHub,
	type ProcessHubManager,
	type ProcessHubSource,
} from "./ui/process-store.ts";
import {
	DEFAULT_EXEC_COMMAND_SETTINGS,
	registerExecCommandXSettings,
	type ExecCommandSettings,
} from "./contributions/xsettings.ts";

export function createExecRuntime(factory: () => ExecSessionManager): ExecRuntime & {
	start(): void;
	shutdown(): Promise<void>;
} {
	let manager: ExecSessionManager | undefined;
	return {
		start() {
			manager ??= factory();
		},
		getManager() {
			manager ??= factory();
			return manager;
		},
		async shutdown() {
			const active = manager;
			manager = undefined;
			await active?.shutdown();
		},
	};
}

export default function execCommandExtension(pi: ExtensionAPI): void {
	let settings = { ...DEFAULT_EXEC_COMMAND_SETTINGS };
	const runtime = createExecRuntime(() =>
		createExecSessionManager({
			binaryPath: resolveExecCommandBinary,
			defaultExecYieldTimeMs: settings.defaultExecYieldMs,
			defaultMaxOutputTokens: settings.defaultOutputTokens,
			defaultLoginShell: settings.defaultLoginShell,
		}),
	);
	let disposeCodeModeAdapters: (() => void) | undefined;
	let processManager: ProcessHubManager | undefined;
	let processStore: ProcessTerminalStore | undefined;
	let processWidget: ProcessWidget | undefined;
	let unregisterProcessHost: (() => void) | undefined;
	const releaseProcessAction = retainProcessHubAction();
	const openProcesses = async (ctx: ExtensionContext, sources?: readonly ProcessHubSource[]): Promise<void> => {
		if (!processManager || !processStore) {
			ctx.ui.notify("Process Hub is unavailable for this session.", "warning");
			return;
		}
		await openProcessHub(
			ctx,
			sources ?? [
				{
					sessionId: ctx.sessionManager.getSessionId(),
					path: "/root",
					store: processStore,
					manager: processManager,
				},
			],
		);
	};
	const applySettings = (next: ExecCommandSettings): void => {
		if (disposeCodeModeAdapters && sameSettings(settings, next)) return;
		settings = { ...next };
		const execCommand = createExecCommandTool(runtime, settings);
		const writeStdin = createWriteStdinTool(runtime, settings);
		pi.registerTool(execCommand);
		pi.registerTool(writeStdin);
		disposeCodeModeAdapters?.();
		disposeCodeModeAdapters = registerCodeModeExecAdapters([execCommand, writeStdin], runtime);
	};
	applySettings(settings);
	const unregisterXSettings = registerExecCommandXSettings(applySettings);
	pi.registerCommand("ps", {
		description: "Open the Process Hub for this session",
		handler: async (_arguments, ctx) => openRegisteredProcessHub(ctx),
	});
	pi.on("session_start", (_event, ctx) => {
		runtime.start();
		const manager = runtime.getManager();
		if (!supportsProcessHub(manager)) return;
		processManager = manager;
		processWidget?.dispose();
		processStore?.dispose();
		processStore = new ProcessTerminalStore(manager);
		processWidget = new ProcessWidget(processStore);
		if (ctx.hasUI) processWidget.setUICtx(ctx.ui);
		unregisterProcessHost?.();
		unregisterProcessHost = registerProcessHubHost(ctx.sessionManager.getSessionId(), {
			store: processStore,
			manager: processManager,
			open: openProcesses,
		});
	});
	pi.on("session_shutdown", async (event) => {
		unregisterProcessHost?.();
		unregisterProcessHost = undefined;
		processWidget?.dispose();
		processWidget = undefined;
		processStore?.dispose();
		processStore = undefined;
		processManager = undefined;
		if (event.reason === "reload" || event.reason === "quit") {
			disposeCodeModeAdapters?.();
			unregisterXSettings();
			releaseProcessAction();
		}
		await runtime.shutdown();
	});
}

function sameSettings(left: ExecCommandSettings, right: ExecCommandSettings): boolean {
	return (
		left.defaultOutputTokens === right.defaultOutputTokens &&
		left.defaultExecYieldMs === right.defaultExecYieldMs &&
		left.defaultLoginShell === right.defaultLoginShell &&
		left.activityMarker === right.activityMarker
	);
}
