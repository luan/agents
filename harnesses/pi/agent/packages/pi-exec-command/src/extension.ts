import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveExecCommandBinary } from "./binary.ts";
import { registerCodeModeExecAdapters } from "./code-mode-adapters.ts";
import { createExecSessionManager, type ExecSessionManager } from "./session-manager.ts";
import { createExecCommandTool } from "./tools/exec-command/definition.ts";
import type { ExecRuntime } from "./tools/runtime.ts";
import { createWriteStdinTool } from "./tools/write-stdin/definition.ts";
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
	pi.on("session_start", () => {
		runtime.start();
	});
	pi.on("session_shutdown", async (event) => {
		if (event.reason === "reload" || event.reason === "quit") {
			disposeCodeModeAdapters?.();
			unregisterXSettings();
		}
		await runtime.shutdown();
	});
}

function sameSettings(left: ExecCommandSettings, right: ExecCommandSettings): boolean {
	return (
		left.defaultOutputTokens === right.defaultOutputTokens &&
		left.defaultExecYieldMs === right.defaultExecYieldMs &&
		left.defaultLoginShell === right.defaultLoginShell
	);
}
