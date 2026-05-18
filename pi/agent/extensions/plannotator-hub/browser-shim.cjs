#!/usr/bin/env node

const { existsSync, readFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const {
	describePlanPayload,
	describeReviewPayload,
	hubLocalBaseUrl,
	validateBackendUrl,
} = require("./shared.cjs");

function sessionContextFromEnv() {
	return {
		sessionId: process.env.PLANNOTATOR_HUB_SESSION_ID,
		sessionFile: process.env.PLANNOTATOR_HUB_SESSION_FILE,
		sessionName: process.env.PLANNOTATOR_HUB_SESSION_NAME,
		cwd: process.env.PLANNOTATOR_HUB_SESSION_CWD,
	};
}

function secretFilePath() {
	return process.env.PLANNOTATOR_HUB_SECRET_FILE || `${process.env.HOME || ""}/.pi/plannotator-hub-secret`;
}

function readSecret() {
	const path = secretFilePath();
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8").trim();
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function healthcheck(baseUrl) {
	try {
		const response = await fetch(`${baseUrl}/api/health`, {
			signal: AbortSignal.timeout(1000),
			cache: "no-store",
		});
		return response.ok;
	} catch {
		return false;
	}
}

function spawnHub() {
	const script = process.env.PLANNOTATOR_HUB_SCRIPT;
	if (!script) throw new Error("PLANNOTATOR_HUB_SCRIPT is not set");
	const child = spawn(process.execPath, [script], {
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();
}

async function ensureHubReady() {
	const baseUrl = hubLocalBaseUrl(process.env);
	if (await healthcheck(baseUrl)) return baseUrl;
	spawnHub();
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await sleep(250);
		if (await healthcheck(baseUrl)) return baseUrl;
	}
	throw new Error(`Plannotator hub did not become ready at ${baseUrl}`);
}

async function fetchJson(url) {
	try {
		const response = await fetch(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(1500),
			cache: "no-store",
		});
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

async function probeBackend(backendUrl) {
	const planData = await fetchJson(`${backendUrl}/api/plan`);
	if (planData && typeof planData.plan === "string") {
		return describePlanPayload(planData);
	}
	const diffData = await fetchJson(`${backendUrl}/api/diff`);
	if (diffData && typeof diffData.rawPatch === "string") {
		return describeReviewPayload(diffData);
	}
	return {
		kind: "plan",
		title: "Plannotator session",
	};
}

async function registerSession(baseUrl, backendUrl) {
	const details = await probeBackend(backendUrl);
	const secret = readSecret();
	if (!secret) throw new Error("Plannotator hub secret is not available");

	const response = await fetch(`${baseUrl}/api/register`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${secret}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			backendUrl,
			...details,
			...sessionContextFromEnv(),
		}),
		signal: AbortSignal.timeout(3000),
	});
	if (!response.ok) {
		throw new Error(`Registration failed with ${response.status}`);
	}
	return response.json();
}

function explicitBrowserCommand() {
	const command = process.env.PLANNOTATOR_HUB_OPEN_BROWSER;
	if (!command) return null;
	if (command === __filename) return null;
	return command;
}

function openWithCommand(command, url) {
	const child = spawn(command, [url], {
		detached: true,
		stdio: "ignore",
		shell: process.platform === "win32",
	});
	child.once("error", () => {});
	child.unref();
}

function openPublicUrl(url) {
	const remote = process.env.SSH_TTY || process.env.SSH_CONNECTION;
	const explicit = explicitBrowserCommand();
	if (explicit) {
		openWithCommand(explicit, url);
		return true;
	}
	if (remote) return false;

	try {
		if (process.platform === "darwin") {
			openWithCommand("open", url);
			return true;
		}
		if (process.platform === "win32") {
			const child = spawn("cmd.exe", ["/c", "start", "", url], {
				detached: true,
				stdio: "ignore",
			});
			child.once("error", () => {});
			child.unref();
			return true;
		}
		openWithCommand("xdg-open", url);
		return true;
	} catch {
		return false;
	}
}

async function main() {
	const rawBackendUrl = process.argv[2];
	if (!rawBackendUrl) return;

	const validated = validateBackendUrl(rawBackendUrl, Number(process.env.PLANNOTATOR_HUB_PORT || "19432"));
	if (!validated.ok) return;

	try {
		const baseUrl = await ensureHubReady();
		const registration = await registerSession(baseUrl, validated.url);
		const targetUrl = typeof registration?.url === "string" ? registration.url : rawBackendUrl;
		openPublicUrl(targetUrl);
	} catch {
		openPublicUrl(rawBackendUrl);
	}
}

void main();
