import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
export type WebSocketLike = WebSocket;
// type-boundary: websocket error events; extractWebSocketError immediately selects a printable message.
type ErrorEvent = unknown;
export function extractWebSocketError(event: ErrorEvent): Error {
	return event instanceof Error
		? event
		: new Error(
				event && typeof event === "object" && "message" in event && typeof event.message === "string"
					? event.message
					: "Voice websocket failed",
			);
}
export function closeWebSocketSilently(socket: WebSocket): void {
	socket.on("error", () => {});
	socket.close();
}
export async function resolveWebSocketProxyForTarget(
	url: string,
	env?: Record<string, string>,
): Promise<string | undefined> {
	const saved = new Map<string, string | undefined>();
	try {
		// proxy-from-env is synchronous; restore scoped provider values before yielding.
		for (const [key, value] of Object.entries(env ?? {}))
			if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)) {
				for (const variant of [key.toLowerCase(), key.toUpperCase()]) {
					saved.set(variant, process.env[variant]);
					delete process.env[variant];
				}
				process.env[key.toLowerCase()] = value;
			}
		return getProxyForUrl(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:")) || undefined;
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
export async function connectWebSocket(
	url: string,
	headers: Headers,
	signal?: AbortSignal,
	timeout = 10_000,
	env?: Record<string, string>,
): Promise<WebSocket> {
	signal?.throwIfAborted();
	const proxy = await resolveWebSocketProxyForTarget(url, env);
	signal?.throwIfAborted();
	const socket = new WebSocket(url, {
		headers: Object.fromEntries(headers),
		handshakeTimeout: timeout,
		maxPayload: 72 * 1024,
		...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
	});
	return new Promise((resolve, reject) => {
		const abort = () => {
			socket.terminate();
			reject(new Error("Voice connection cancelled"));
		};
		const cleanup = () => signal?.removeEventListener("abort", abort);
		signal?.addEventListener("abort", abort, { once: true });
		socket.once("open", () => {
			cleanup();
			resolve(socket);
		});
		socket.once("error", (error) => {
			cleanup();
			reject(error);
		});
		socket.once("close", () => {
			cleanup();
			reject(new Error("Voice connection closed before opening"));
		});
	});
}
