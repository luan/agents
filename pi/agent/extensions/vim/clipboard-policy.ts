import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

export type ClipboardMirrorPolicy = "all" | "yank" | "never";
export type RegisterWriteSource = "mutation" | "yank";

export const DEFAULT_CLIPBOARD_MIRROR_POLICY: ClipboardMirrorPolicy = "all";

export type PiVimSettings = { clipboardMirror?: unknown };

type UnknownRecord = Record<string, unknown>;

const missing = Symbol();

function formatInvalid(value: unknown) {
	const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
	try {
		return `${JSON.stringify(value) ?? type} (type ${type})`;
	} catch {
		return `(type ${type})`;
	}
}

function readSetting(settings: unknown): unknown {
	if (typeof settings !== "object" || settings === null || !Object.hasOwn(settings, "piVim")) return missing;
	const piVim = (settings as UnknownRecord).piVim;
	if (typeof piVim !== "object" || piVim === null || Array.isArray(piVim)) return piVim;
	return Object.hasOwn(piVim, "clipboardMirror") ? (piVim as UnknownRecord).clipboardMirror : missing;
}

export function resolveClipboardMirrorPolicy(value: unknown) {
	if (value === undefined) return { policy: DEFAULT_CLIPBOARD_MIRROR_POLICY };

	if (typeof value === "string") {
		const policy = value.trim().toLowerCase();
		if (policy === "all" || policy === "yank" || policy === "never") {
			return { policy: policy as ClipboardMirrorPolicy };
		}
	}

	return {
		policy: DEFAULT_CLIPBOARD_MIRROR_POLICY,
		warning: `Invalid piVim.clipboardMirror ${formatInvalid(value)}; expected all, yank, never. Using all.`,
	};
}

export function readPiVimClipboardMirrorSetting(
	globalSettings: unknown,
	projectSettings: unknown,
): unknown | undefined {
	const project = readSetting(projectSettings);
	if (project !== missing) return project;
	const global = readSetting(globalSettings);
	return global === missing ? undefined : global;
}

type SettingsReader = {
	getGlobalSettings?: () => unknown;
	getProjectSettings?: () => unknown;
};

function synchronousSettingsReader(value: unknown): SettingsReader | undefined {
	if (!value || typeof value !== "object") return undefined;
	if ("then" in value && typeof (value as { then?: unknown }).then === "function") {
		void (value as PromiseLike<unknown>).then(undefined, () => {});
		return undefined;
	}
	return value as SettingsReader;
}

function readJsonFile(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function fallbackGlobalSettings(): unknown {
	const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
	const candidates = [
		configuredAgentDir ? join(expandHome(configuredAgentDir), "settings.json") : undefined,
		join(homedir(), ".omp", "agent", "settings.json"),
		join(homedir(), ".pi", "agent", "settings.json"),
	].filter((path): path is string => Boolean(path));
	for (const path of candidates) {
		const settings = readJsonFile(path);
		if (readSetting(settings) !== missing) return settings;
	}
	return undefined;
}

function fallbackProjectSettings(cwd: string): unknown {
	for (const path of [join(cwd, ".omp", "settings.json"), join(cwd, ".pi", "settings.json")]) {
		const settings = readJsonFile(path);
		if (readSetting(settings) !== missing) return settings;
	}
	return undefined;
}

function readPiVimSettingsFromDisk(cwd: string): PiVimSettings {
	const settings = synchronousSettingsReader(SettingsManager.create(cwd));
	const globalSettings = settings?.getGlobalSettings?.() ?? fallbackGlobalSettings();
	const projectSettings = settings?.getProjectSettings?.() ?? fallbackProjectSettings(cwd);
	return {
		clipboardMirror: readPiVimClipboardMirrorSetting(globalSettings, projectSettings),
	};
}

let piVimSettingsReader = readPiVimSettingsFromDisk;

export function readPiVimSettings(cwd: string) {
	return piVimSettingsReader(cwd);
}

export function setPiVimSettingsReaderForTests(reader: typeof readPiVimSettingsFromDisk) {
	const prev = piVimSettingsReader;
	piVimSettingsReader = reader;

	return () => {
		piVimSettingsReader = prev;
	};
}
