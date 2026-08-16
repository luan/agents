// The toggle lives here rather than in tool-policy/config.json: turning code-mode off overlays Direct onto every
// Declared tool at resolution time, and that stored config has to survive a toggle byte-identical.
// The loader gives each extension its own jiti (`moduleCache: false`), so the live value hangs off `globalThis`
// the way tool-policy/policy.ts:269 does; a separate pi process reads the file at its own boot.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CODE_MODE_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "config.json");

type CodeModeConfig = { enabled: boolean };
type CodeModeState = { enabled?: boolean };

const CODE_MODE_STATE = Symbol.for("agents.codeMode");
const modeState = globalThis as typeof globalThis & Record<symbol, CodeModeState | undefined>;
const modeSlot = modeState[CODE_MODE_STATE] ?? {};
modeState[CODE_MODE_STATE] = modeSlot;

/** A missing or corrupt file keeps Code Mode on. */
function readCodeModeConfig(): CodeModeConfig {
	try {
		const parsed = JSON.parse(readFileSync(CODE_MODE_CONFIG_PATH, "utf8")) as { enabled?: unknown };
		return { enabled: parsed.enabled !== false };
	} catch {
		return { enabled: true };
	}
}

function currentState(): Required<CodeModeState> {
	if (modeSlot.enabled === undefined) {
		modeSlot.enabled ??= readCodeModeConfig().enabled;
	}
	return { enabled: modeSlot.enabled ?? true };
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
