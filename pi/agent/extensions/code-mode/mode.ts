// The toggle lives here rather than in tool-policy/config.json: turning code-mode off overlays Direct onto every
// Declared tool at resolution time, and that stored config has to survive a toggle byte-identical.
// The loader gives each extension its own jiti (`moduleCache: false`), so the live value hangs off `globalThis`
// the way tool-policy/policy.ts:269 does; a separate pi process reads the file at its own boot.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CODE_MODE_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "config.json");

/**
 * Which backend runs a cell.
 *
 * `rust` is the forked in-process V8 host (crates/code-mode-host). Cell state lives in memory and
 * dies with the process.
 * `notebook` is a `deno jupyter --kernel` process reached through a Node sidecar. State survives a
 * restart through checkpoints and the project journal.
 */
export type CodeModeRuntime = "rust" | "notebook";

type CodeModeConfig = { enabled: boolean; runtime: CodeModeRuntime };
type CodeModeState = { enabled?: boolean; activeRuntime?: CodeModeRuntime };

const CODE_MODE_STATE = Symbol.for("agents.codeMode");
const modeState = globalThis as typeof globalThis & Record<symbol, CodeModeState | undefined>;
const modeSlot = modeState[CODE_MODE_STATE] ?? {};
modeState[CODE_MODE_STATE] = modeSlot;

/** A missing or corrupt file keeps Code Mode on, on the Rust backend. */
function readCodeModeConfig(): CodeModeConfig {
	try {
		const parsed = JSON.parse(readFileSync(CODE_MODE_CONFIG_PATH, "utf8")) as {
			enabled?: unknown;
			runtime?: unknown;
		};
		return { enabled: parsed.enabled !== false, runtime: parsed.runtime === "notebook" ? "notebook" : "rust" };
	} catch {
		return { enabled: true, runtime: "rust" };
	}
}

function currentState(): Required<CodeModeState> {
	if (modeSlot.enabled === undefined || modeSlot.activeRuntime === undefined) {
		const config = readCodeModeConfig();
		modeSlot.enabled ??= config.enabled;
		// Pinned at first read. A cell must not change backend underneath a live kernel.
		modeSlot.activeRuntime ??= config.runtime;
	}
	return { enabled: modeSlot.enabled ?? true, activeRuntime: modeSlot.activeRuntime ?? "rust" };
}

function writeCodeModeConfig(config: CodeModeConfig): void {
	const tmpPath = `${CODE_MODE_CONFIG_PATH}.tmp`;
	mkdirSync(dirname(CODE_MODE_CONFIG_PATH), { recursive: true });
	writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(tmpPath, CODE_MODE_CONFIG_PATH);
}

/** On: only `exec`, `wait` and the direct set reach the model, and every other tool runs inside a cell. */
export function isCodeModeEnabled(): boolean {
	return currentState().enabled;
}

export function setCodeModeEnabled(enabled: boolean): void {
	writeCodeModeConfig({ ...readCodeModeConfig(), enabled });
	modeSlot.enabled = enabled;
}

/** The backend saved for the next Pi process. */
export function getCodeModeRuntime(): CodeModeRuntime {
	return readCodeModeConfig().runtime;
}

/** The backend this Pi process started with. A running kernel keeps it for the process lifetime. */
export function getActiveCodeModeRuntime(): CodeModeRuntime {
	return currentState().activeRuntime;
}

export function setCodeModeRuntime(runtime: CodeModeRuntime): void {
	const config = readCodeModeConfig();
	if (config.runtime === runtime) return;
	writeCodeModeConfig({ ...config, runtime });
}
