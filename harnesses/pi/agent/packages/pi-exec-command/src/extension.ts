import { existsSync } from "node:fs";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerSidePanelProvider, type ActivityAnimationOverrides } from "pi-libtui";
import { resolveExecCommandBinary } from "./binary.ts";
import { registerCodeModeExecAdapters } from "./code-mode-adapters.ts";
import { openRegisteredProcessHub, registerProcessHubHost, retainProcessHubAction } from "./contributions/actions.ts";
import {
	DEFAULT_EXEC_COMMAND_SETTINGS,
	type ExecCommandSettings,
	registerExecCommandXSettings,
} from "./contributions/xsettings.ts";
import { createExecSessionManager, type ExecSessionManager } from "./session-manager.ts";
import { createExecShellResolver } from "./runtime-shell.ts";
import { createExecCommandTool } from "./tools/exec-command/definition.ts";
import type { ExecRuntime } from "./tools/runtime.ts";
import { createWriteStdinTool } from "./tools/write-stdin/definition.ts";
import { ProcessHubPresentation } from "./ui/process-hub-presentation.ts";
import {
	type ProcessHubManager,
	type ProcessHubSource,
	ProcessTerminalStore,
	supportsProcessHub,
} from "./ui/process-store.ts";
import { ProcessWidget } from "./ui/process-widget.ts";

export function createExecRuntime(factory: () => ExecSessionManager): ExecRuntime & {
	start(): void;
	shutdown(): Promise<void>;
} {
	let manager: ExecSessionManager | undefined;
	let shutdownPromise: Promise<void> | undefined;
	return {
		start() {
			manager ??= factory();
		},
		getManager() {
			manager ??= factory();
			return manager;
		},
		shutdown() {
			if (shutdownPromise) return shutdownPromise;
			const active = manager;
			manager = undefined;
			const completion = (active?.shutdown() ?? Promise.resolve()).finally(() => {
				if (shutdownPromise === completion) shutdownPromise = undefined;
			});
			shutdownPromise = completion;
			return completion;
		},
	};
}

export default function execCommandExtension(pi: ExtensionAPI): void {
	let settings = { ...DEFAULT_EXEC_COMMAND_SETTINGS };
	const resolveShell = createExecShellResolver({
		platform: process.platform,
		variables: process.env,
		exists: existsSync,
	});
	const preparationRuntime = {
		configuredShell(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): string | undefined {
			return SettingsManager.create(ctx.cwd, getAgentDir(), {
				projectTrusted: ctx.isProjectTrusted(),
			}).getShellPath();
		},
		resolveShell,
	};
	const runtime = createExecRuntime(() =>
		createExecSessionManager(
			{
				binaryPath: resolveExecCommandBinary,
				defaultExecYieldTimeMs: settings.defaultExecYieldMs,
				defaultMaxOutputTokens: settings.defaultOutputTokens,
				defaultLoginShell: settings.defaultLoginShell,
			},
			{
				now: Date.now,
				processId: (sessionId) => `pi-${process.pid}-${sessionId}`,
				resolveShell,
				schedule: (delayMs, callback) => {
					const timer = setTimeout(callback, delayMs);
					return { dispose: () => clearTimeout(timer) };
				},
			},
		),
	);
	let disposeCodeModeAdapters: (() => void) | undefined;
	let processManager: ProcessHubManager | undefined;
	let processStore: ProcessTerminalStore | undefined;
	let processWidget: ProcessWidget | undefined;
	let unregisterProcessHost: (() => void) | undefined;
	let unregisterSidePanelProvider: (() => void) | undefined;
	const processHubPresentation = new ProcessHubPresentation();
	const releaseProcessAction = retainProcessHubAction();
	const openProcesses = async (
		ctx: ExtensionContext,
		sources?: readonly ProcessHubSource[],
		initialProcessKey?: string,
	): Promise<void> => {
		if (!processManager || !processStore) {
			ctx.ui.notify("Process Hub is unavailable for this session.", "warning");
			return;
		}
		await processHubPresentation.open(
			ctx,
			settings.processHubPresentation,
			sources ?? [
				{
					sessionId: ctx.sessionManager.getSessionId(),
					path: "/root",
					store: processStore,
					manager: processManager,
				},
			],
			initialProcessKey,
		);
	};
	const applySettings = (next: ExecCommandSettings): void => {
		const unchanged = disposeCodeModeAdapters && sameSettings(settings, next);
		settings = { ...next };
		if (settings.processHubPresentation === "fullscreen") processHubPresentation.closeSidePanel();
		processWidget?.setAnimation(processWidgetAnimation(settings));
		if (unchanged) return;
		const execCommand = createExecCommandTool(runtime, preparationRuntime, settings);
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
		processWidget = new ProcessWidget(
			processStore,
			(processId) => void openRegisteredProcessHub(ctx, processId),
			processWidgetAnimation(settings),
		);
		if (ctx.hasUI) processWidget.setUICtx(ctx.ui);
		unregisterProcessHost?.();
		unregisterProcessHost = registerProcessHubHost(ctx.sessionManager.getSessionId(), {
			store: processStore,
			manager: processManager,
			open: openProcesses,
		});
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		unregisterSidePanelProvider?.();
		unregisterSidePanelProvider = registerSidePanelProvider(
			{
				id: "pi-exec-command.process-hub",
				session: ctx,
				attach(panel) {
					return processHubPresentation.attach(panel);
				},
			},
			globalThis,
		);
	});
	pi.on("session_shutdown", async (event) => {
		unregisterSidePanelProvider?.();
		unregisterSidePanelProvider = undefined;
		processHubPresentation.closeSidePanel();
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
		left.activityIndicator === right.activityIndicator &&
		left.processWidgetIndicator === right.processWidgetIndicator &&
		left.processHubPresentation === right.processHubPresentation
	);
}

function processWidgetAnimation(
	settings: Pick<ExecCommandSettings, "processWidgetIndicator">,
): Readonly<ActivityAnimationOverrides> {
	return settings.processWidgetIndicator === "inherit" ? {} : { indicatorStyle: settings.processWidgetIndicator };
}
