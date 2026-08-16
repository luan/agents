/*
 * Adapted from packages/pi-codex-conversion/src/providers/openai-codex.
 * Pi 0.84 owns the primary provider transport; this seam serves local Codex tools.
 * See codex-transport.LICENSE and codex-transport.UPSTREAM.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_MAX_RETRIES = 4;
const BASE_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const SSE_HEADER_TIMEOUT_MS = 20_000;

export class CodexApiError extends Error {
	readonly code?: string;
	readonly payload?: Record<string, unknown>;

	constructor(message: string, options?: { code?: string; payload?: Record<string, unknown>; cause?: unknown }) {
		super(message, { cause: options?.cause });
		this.name = "CodexApiError";
		this.code = options?.code;
		this.payload = options?.payload;
	}
}

function isTerminalRateLimitError(text: string): boolean {
	return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
		text,
	);
}

function isRetryableError(status: number, text: string): boolean {
	if (status === 429 && isTerminalRateLimitError(text)) return false;
	return (
		status === 429 ||
		status === 500 ||
		status === 502 ||
		status === 503 ||
		status === 504 ||
		/rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(text)
	);
}

function retryAfterMs(headers: Headers): number | undefined {
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs !== null) {
		const value = Number(retryAfterMs);
		if (Number.isFinite(value)) return Math.max(0, value);
	}
	const retryAfter = headers.get("retry-after");
	if (!retryAfter) return undefined;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
	const date = Date.parse(retryAfter);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
	try {
		await delay(ms, undefined, { signal });
	} catch {
		throw new Error("Request was aborted");
	}
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): {
	signal?: AbortSignal;
	cleanup: () => void;
} {
	const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (active.length === 0) return { cleanup: () => {} };
	if (active.length === 1) return { signal: active[0], cleanup: () => {} };
	const controller = new AbortController();
	const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
	const abort = (signal: AbortSignal) => {
		if (!controller.signal.aborted) controller.abort(signal.reason);
	};
	for (const signal of active) {
		if (signal.aborted) abort(signal);
		const listener = () => abort(signal);
		signal.addEventListener("abort", listener, { once: true });
		listeners.push({ signal, listener });
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
		},
	};
}

export async function fetchCodexSSEWithRetries(
	url: string,
	headers: Headers,
	body: Record<string, unknown>,
	options?: Pick<SimpleStreamOptions, "signal" | "maxRetries" | "maxRetryDelayMs">,
): Promise<Response> {
	const configuredRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
	if (!Number.isFinite(configuredRetries) || configuredRetries < 0) {
		throw new Error(`Invalid maxRetries: ${String(configuredRetries)}`);
	}
	const maxRetries = Math.min(Math.floor(configuredRetries), 100);
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (options?.signal?.aborted) throw new Error("Request was aborted");
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), SSE_HEADER_TIMEOUT_MS);
		const combined = combineSignals([options?.signal, timeout.signal]);
		try {
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: combined.signal,
			});
			if (response.ok) return response;
			const detail = await response.clone().text();
			if (attempt < maxRetries && isRetryableError(response.status, detail)) {
				const requested = retryAfterMs(response.headers) ?? BASE_RETRY_DELAY_MS * 2 ** attempt;
				const cap = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
				await wait(cap > 0 ? Math.min(requested, cap) : requested, options?.signal);
				continue;
			}
			return response;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (attempt < maxRetries) {
				await wait(BASE_RETRY_DELAY_MS * 2 ** attempt, options?.signal);
			}
		} finally {
			clearTimeout(timer);
			combined.cleanup();
		}
	}
	throw lastError ?? new Error("Codex SSE request failed");
}

export async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
			let separator = buffer.indexOf("\n\n");
			while (separator !== -1) {
				const data = parseSseData(buffer.slice(0, separator));
				buffer = buffer.slice(separator + 2);
				if (data && data !== "[DONE]") yield parseSseJson(data);
				separator = buffer.indexOf("\n\n");
			}
		}
		const data = parseSseData(buffer.replace(/\r\n/g, "\n"));
		if (data && data !== "[DONE]") yield parseSseJson(data);
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function parseSseData(chunk: string): string {
	return chunk
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).trim())
		.join("\n")
		.trim();
}

function parseSseJson(data: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(data);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch (cause) {
		throw new CodexApiError(`Invalid Codex SSE JSON: ${cause instanceof Error ? cause.message : String(cause)}`, {
			payload: { data },
			cause,
		});
	}
}

export function resolveCodexUrl(baseUrl?: string): string {
	const raw = baseUrl?.trim() || DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

export function extractAccountId(token: string): string {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8"));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (typeof accountId !== "string" || !accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

export function buildSSEHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
	sessionId?: string,
): Headers {
	const headers = new Headers(initHeaders);
	for (const [key, value] of Object.entries(additionalHeaders ?? {})) headers.set(key, value);
	headers.set("authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	headers.set("user-agent", "pi (openai-codex)");
	headers.set("openai-beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (sessionId) {
		headers.set("session-id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}
	return headers;
}
