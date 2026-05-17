import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const DEFAULT_HUB_PORT = "19432";
const DEFAULT_HUB_BIND = "127.0.0.1";
const DISABLE_ENV = "PLANNOTATOR_HUB_DISABLED";
const HUB_START_TIMEOUT_MS = 5_000;
const missing = Symbol("plannotatorHubMissing");

type UnknownRecord = Record<string, unknown>;
type PlannotatorHubSettings = {
	enabled?: unknown;
	publicUrl?: unknown;
	port?: unknown;
	bind?: unknown;
};

function extensionDir() {
	return dirname(fileURLToPath(import.meta.url));
}

export function getPlannotatorHubPaths() {
	const dir = extensionDir();
	return {
		browserShimPath: resolve(dir, "browser-shim.cjs"),
		hubServerPath: resolve(dir, "hub-server.cjs"),
	};
}

function defaultPublicUrl(env: NodeJS.ProcessEnv) {
	const port = env.PLANNOTATOR_HUB_PORT || DEFAULT_HUB_PORT;
	return `http://127.0.0.1:${port}`;
}

function applyBrowserShim(env: NodeJS.ProcessEnv, browserShimPath: string) {
	const existingBrowser = env.PLANNOTATOR_BROWSER || env.BROWSER;
	if (!env.PLANNOTATOR_HUB_OPEN_BROWSER && existingBrowser && existingBrowser !== browserShimPath) {
		env.PLANNOTATOR_HUB_OPEN_BROWSER = existingBrowser;
	}

	if (process.platform === "darwin") {
		env.BROWSER = browserShimPath;
		delete env.PLANNOTATOR_BROWSER;
		return;
	}

	env.PLANNOTATOR_BROWSER = browserShimPath;
}

function parseString(value: unknown) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePort(value: unknown) {
	if (typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536) {
		return String(value);
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (/^\d+$/.test(trimmed)) {
			const parsed = Number(trimmed);
			if (parsed > 0 && parsed < 65536) return trimmed;
		}
	}
	return undefined;
}

function parseEnabled(value: unknown) {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "1") return true;
		if (normalized === "false" || normalized === "0") return false;
	}
	return undefined;
}

function readSetting(settings: unknown): PlannotatorHubSettings | typeof missing {
	if (typeof settings !== "object" || settings === null || !Object.hasOwn(settings, "plannotatorHub")) return missing;
	const value = (settings as UnknownRecord).plannotatorHub;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { enabled: value };
	return value as PlannotatorHubSettings;
}

function readPlannotatorHubSettingsFromDisk(cwd: string) {
	const settings = SettingsManager.create(cwd);
	const project = readSetting(settings.getProjectSettings());
	const global = readSetting(settings.getGlobalSettings());
	const merged = {
		...(global === missing ? {} : global),
		...(project === missing ? {} : project),
	};
	return {
		enabled: parseEnabled(merged.enabled),
		publicUrl: parseString(merged.publicUrl),
		port: parsePort(merged.port),
		bind: parseString(merged.bind),
	};
}

let plannotatorHubSettingsReader = readPlannotatorHubSettingsFromDisk;

export function setPlannotatorHubSettingsReaderForTests(reader: typeof readPlannotatorHubSettingsFromDisk) {
	const previous = plannotatorHubSettingsReader;
	plannotatorHubSettingsReader = reader;
	return () => {
		plannotatorHubSettingsReader = previous;
	};
}

export function readPlannotatorHubSettings(cwd: string) {
	return plannotatorHubSettingsReader(cwd);
}

export function applyPlannotatorHubEnvironment(options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
	const env = options.env ?? process.env;
	const settings = readPlannotatorHubSettings(options.cwd ?? process.cwd());
	if (settings.enabled === false || env[DISABLE_ENV] === "1" || env[DISABLE_ENV] === "true") return;

	const { browserShimPath, hubServerPath } = getPlannotatorHubPaths();
	env.PLANNOTATOR_HUB_PORT = settings.port ?? env.PLANNOTATOR_HUB_PORT ?? DEFAULT_HUB_PORT;
	env.PLANNOTATOR_HUB_BIND = settings.bind ?? env.PLANNOTATOR_HUB_BIND ?? DEFAULT_HUB_BIND;
	env.PLANNOTATOR_HUB_PUBLIC_URL = settings.publicUrl ?? env.PLANNOTATOR_HUB_PUBLIC_URL ?? defaultPublicUrl(env);
	env.PLANNOTATOR_HUB_SCRIPT ||= hubServerPath;

	// The hub owns the fixed public port. Upstream Plannotator must stay on random loopback ports.
	env.PLANNOTATOR_REMOTE = "false";
	delete env.PLANNOTATOR_PORT;
	applyBrowserShim(env, browserShimPath);
}

function localHubBaseUrl(env: NodeJS.ProcessEnv = process.env) {
	const host = env.PLANNOTATOR_HUB_BIND || DEFAULT_HUB_BIND;
	const resolvedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
	const port = env.PLANNOTATOR_HUB_PORT || DEFAULT_HUB_PORT;
	return `http://${resolvedHost}:${port}`;
}

async function isHubHealthy(env: NodeJS.ProcessEnv = process.env) {
	try {
		const response = await fetch(`${localHubBaseUrl(env)}/api/health`, {
			cache: "no-store",
			signal: AbortSignal.timeout(1_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

function startHubProcess(env: NodeJS.ProcessEnv = process.env) {
	const scriptPath = env.PLANNOTATOR_HUB_SCRIPT;
	if (!scriptPath) return;
	const child = spawn(process.execPath, [scriptPath], {
		detached: true,
		stdio: "ignore",
		env,
	});
	child.once("error", () => {});
	child.unref();
}

async function ensurePlannotatorHub(env: NodeJS.ProcessEnv = process.env) {
	if (await isHubHealthy(env)) return;

	startHubProcess(env);
	const deadline = Date.now() + HUB_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		if (await isHubHealthy(env)) return;
	}
}

function setOrDelete(env: NodeJS.ProcessEnv, key: string, value?: string) {
	if (value) env[key] = value;
	else delete env[key];
}

export function syncPlannotatorHubSessionContext(ctx: ExtensionContext, env: NodeJS.ProcessEnv = process.env) {
	setOrDelete(env, "PLANNOTATOR_HUB_SESSION_ID", ctx.sessionManager.getSessionId());
	setOrDelete(env, "PLANNOTATOR_HUB_SESSION_FILE", ctx.sessionManager.getSessionFile());
	setOrDelete(env, "PLANNOTATOR_HUB_SESSION_NAME", ctx.sessionManager.getSessionName());
	setOrDelete(env, "PLANNOTATOR_HUB_SESSION_CWD", ctx.cwd);
}

function clearPlannotatorHubSessionContext(env: NodeJS.ProcessEnv = process.env) {
	delete env.PLANNOTATOR_HUB_SESSION_ID;
	delete env.PLANNOTATOR_HUB_SESSION_FILE;
	delete env.PLANNOTATOR_HUB_SESSION_NAME;
	delete env.PLANNOTATOR_HUB_SESSION_CWD;
}

export default function plannotatorHubExtension(pi: ExtensionAPI): void {
	applyPlannotatorHubEnvironment();
	void ensurePlannotatorHub();
	pi.on("session_start", async (_event, ctx) => {
		applyPlannotatorHubEnvironment({ cwd: ctx.cwd });
		syncPlannotatorHubSessionContext(ctx);
		await ensurePlannotatorHub();
	});
	pi.on("session_shutdown", () => {
		clearPlannotatorHubSessionContext();
	});
}
