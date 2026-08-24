import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type OAuthToken = { access: string; refresh: string; expires: number };
type DeviceAuth = { id: string; userCode: string; intervalMs: number };
type DeviceToken = { authorizationCode: string; codeVerifier: string };

function callbackHost(): string {
	return process.env["PI_OAUTH_CALLBACK_HOST"]?.trim() || "127.0.0.1";
}

function base64Url(buffer: Buffer): string {
	return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function createPkce(): { verifier: string; challenge: string } {
	const verifier = base64Url(randomBytes(32));
	const challenge = base64Url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// The input can be a code or a query fragment.
	}
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}
	return { code: value };
}

function accountId(accessToken: string): string {
	try {
		const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
			[JWT_CLAIM_PATH]?: { chatgpt_account_id?: unknown };
		};
		const value = payload[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (typeof value === "string" && value.length > 0) return value;
	} catch {
		// Report one stable error below.
	}
	throw new Error("Failed to extract accountId from token");
}

function credential(token: OAuthToken): OAuthCredential {
	return {
		type: "oauth",
		access: token.access,
		refresh: token.refresh,
		expires: token.expires,
		accountId: accountId(token.access),
	};
}

async function tokenResponse(response: Response, operation: "exchange" | "refresh"): Promise<OAuthToken> {
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`OpenAI Codex token ${operation} failed (${response.status}): ${text || response.statusText}`);
	}
	const value = (await response.json()) as {
		access_token?: unknown;
		refresh_token?: unknown;
		expires_in?: unknown;
	};
	if (
		typeof value.access_token !== "string" ||
		typeof value.refresh_token !== "string" ||
		typeof value.expires_in !== "number"
	) {
		throw new Error(`OpenAI Codex token ${operation} response is incomplete`);
	}
	return {
		access: value.access_token,
		refresh: value.refresh_token,
		expires: Date.now() + value.expires_in * 1000,
	};
}

async function exchangeCode(
	code: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
		signal,
	});
	return credential(await tokenResponse(response, "exchange"));
}

async function refreshCredential(current: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: current.refresh,
			client_id: CLIENT_ID,
		}),
		signal,
	});
	return credential(await tokenResponse(response, "refresh"));
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const timer = setTimeout(done, ms);
		function done() {
			cleanup();
			resolve();
		}
		function abort() {
			cleanup();
			reject(new Error("Login cancelled"));
		}
		function cleanup() {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		}
		signal.addEventListener("abort", abort, { once: true });
	});
}

async function beginDeviceAuth(signal: AbortSignal): Promise<DeviceAuth> {
	const response = await fetch(DEVICE_USER_CODE_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID }),
		signal,
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`OpenAI Codex device code request failed (${response.status}): ${text || response.statusText}`);
	}
	const value = (await response.json()) as {
		device_auth_id?: unknown;
		user_code?: unknown;
		interval?: unknown;
	};
	const seconds = typeof value.interval === "string" ? Number(value.interval) : value.interval;
	if (
		typeof value.device_auth_id !== "string" ||
		typeof value.user_code !== "string" ||
		typeof seconds !== "number" ||
		!Number.isFinite(seconds)
	) {
		throw new Error("OpenAI Codex returned an invalid device code response");
	}
	return { id: value.device_auth_id, userCode: value.user_code, intervalMs: Math.max(0, seconds * 1000) };
}

async function pollDeviceAuth(device: DeviceAuth, signal: AbortSignal): Promise<DeviceToken> {
	const deadline = Date.now() + DEVICE_CODE_TIMEOUT_MS;
	let intervalMs = device.intervalMs;
	while (Date.now() < deadline) {
		await wait(intervalMs, signal);
		const response = await fetch(DEVICE_TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ device_auth_id: device.id, user_code: device.userCode }),
			signal,
		});
		if (response.ok) {
			const value = (await response.json()) as { authorization_code?: unknown; code_verifier?: unknown };
			if (typeof value.authorization_code === "string" && typeof value.code_verifier === "string") {
				return { authorizationCode: value.authorization_code, codeVerifier: value.code_verifier };
			}
			throw new Error("OpenAI Codex returned an invalid device token response");
		}
		if (response.status === 403 || response.status === 404) continue;
		const text = await response.text().catch(() => "");
		if (/deviceauth_authorization_pending/.test(text)) continue;
		if (/slow_down/.test(text)) {
			intervalMs += 5_000;
			continue;
		}
		throw new Error(`OpenAI Codex device auth failed (${response.status}): ${text || response.statusText}`);
	}
	throw new Error("OpenAI Codex device code expired");
}

async function loginWithDeviceCode(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const device = await beginDeviceAuth(interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: device.userCode,
		verificationUri: DEVICE_VERIFICATION_URI,
		intervalSeconds: device.intervalMs / 1000,
		expiresInSeconds: DEVICE_CODE_TIMEOUT_MS / 1000,
	});
	const code = await pollDeviceAuth(device, interaction.signal);
	return exchangeCode(code.authorizationCode, code.codeVerifier, DEVICE_REDIRECT_URI, interaction.signal);
}

function authorizationFlow(): { verifier: string; state: string; url: string } {
	const { verifier, challenge } = createPkce();
	const state = randomBytes(16).toString("hex");
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", "pi");
	return { verifier, state, url: url.toString() };
}

function callbackPage(message: string): string {
	return `<!doctype html><meta charset="utf-8"><title>OpenAI Codex</title><body><p>${message}</p></body>`;
}

async function startCallbackServer(expectedState: string): Promise<{
	server: Server;
	waitForCode: Promise<string | undefined>;
	cancel: () => void;
}> {
	let settle: ((code: string | undefined) => void) | undefined;
	const waitForCode = new Promise<string | undefined>((resolve) => {
		settle = resolve;
	});
	const server = createServer((request, response) => {
		const url = new URL(request.url || "", "http://localhost");
		response.setHeader("content-type", "text/html; charset=utf-8");
		if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== expectedState) {
			response.statusCode = 400;
			response.end(callbackPage("OpenAI authentication failed."));
			return;
		}
		const code = url.searchParams.get("code") ?? undefined;
		response.statusCode = code ? 200 : 400;
		response.end(
			callbackPage(
				code ? "OpenAI authentication completed. You can close this window." : "Missing authorization code.",
			),
		);
		if (code) settle?.(code);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(1455, callbackHost(), () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	return { server, waitForCode, cancel: () => settle?.(undefined) };
}

async function loginWithBrowser(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const flow = authorizationFlow();
	const callback = await startCallbackServer(flow.state);
	const manualAbort = new AbortController();
	const abort = () => callback.cancel();
	interaction.signal.addEventListener("abort", abort, { once: true });
	interaction.notify({
		type: "auth_url",
		url: flow.url,
		instructions: "Complete login in the browser.",
	});
	try {
		const manual = interaction
			.prompt({
				type: "manual_code",
				message: "Complete login in the browser, or paste the authorization code or redirect URL:",
				placeholder: REDIRECT_URI,
				signal: manualAbort.signal,
			})
			.then((value) => ({ source: "manual" as const, value }));
		const browser = callback.waitForCode.then((value) => ({ source: "browser" as const, value }));
		const result = await Promise.race([manual, browser]);
		const parsed = result.source === "manual" ? parseAuthorizationInput(result.value ?? "") : { code: result.value };
		if (parsed.state && parsed.state !== flow.state) throw new Error("OpenAI Codex OAuth state mismatch");
		if (!parsed.code) throw new Error("Missing authorization code");
		return await exchangeCode(parsed.code, flow.verifier, REDIRECT_URI, interaction.signal);
	} finally {
		interaction.signal.removeEventListener("abort", abort);
		manualAbort.abort();
		callback.cancel();
		callback.server.close();
	}
}

export const codexOAuth: OAuthAuth = {
	name: "OpenAI Codex (ChatGPT Plus/Pro)",
	isSubscription: true,
	async login(interaction) {
		const method = await interaction.prompt({
			type: "select",
			message: "Select OpenAI Codex login method:",
			options: [
				{ id: "browser", label: "Browser login" },
				{ id: "device_code", label: "Device code login", description: "Use this on a headless system." },
			],
		});
		if (method === "browser") return loginWithBrowser(interaction);
		if (method === "device_code") return loginWithDeviceCode(interaction);
		throw new Error(`Unknown OpenAI Codex login method: ${method}`);
	},
	refresh: refreshCredential,
	async toAuth(current) {
		return { apiKey: current.access };
	},
};
