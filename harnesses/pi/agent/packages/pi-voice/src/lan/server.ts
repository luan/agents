import { createServer } from "node:https";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { VoiceController } from "../controller.ts";
import { CodexDictationTranscriber } from "../dictation/transcriber.ts";
import { resolveCodexVoiceAuth } from "../auth.ts";
import { LanHostRealtimePeer } from "./browser-peer.ts";
import { resolveLanVoiceCertificate } from "./certificate.ts";
import type { JsonValue } from "../wire-value.ts";
export interface PhoneServer {
	urls: string[];
	close(): Promise<void>;
	message(text: string): void;
}
export function validPhoneToken(supplied: string, expected: string): boolean {
	const first = Buffer.from(supplied),
		second = Buffer.from(expected);
	return first.length === second.length && timingSafeEqual(first, second);
}
function bytes(data: RawData): Buffer {
	return Array.isArray(data)
		? Buffer.concat(data)
		: data instanceof ArrayBuffer
			? Buffer.from(new Uint8Array(data))
			: data;
}
export async function startPhoneServer(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	voice: Pick<VoiceController, "subscribe" | "status" | "active" | "muted" | "start" | "stop" | "mute" | "input">,
): Promise<PhoneServer> {
	const certificate = await resolveLanVoiceCertificate(join(getAgentDir(), "cache", "pi-voice"));
	const token = randomBytes(32).toString("base64url");
	const assets = new Map(
		await Promise.all(
			["index.html", "client.js", "audio-worklet.js"].map(
				async (name) => [name, await readFile(new URL(name, import.meta.url))] as const,
			),
		),
	);
	const server = createServer(certificate, (request, response) => {
		const path = request.url === "/" ? "index.html" : request.url?.slice(1);
		const asset = path ? assets.get(path) : undefined;
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'",
		);
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		if (request.method !== "GET" || !asset) {
			response.writeHead(404);
			response.end();
			return;
		}
		response.setHeader(
			"Content-Type",
			path?.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
		);
		response.end(asset);
	});
	const sockets = new WebSocketServer({ noServer: true, maxPayload: 72 * 1024, handleProtocols: () => "pi-voice" });
	let owner: WebSocket | undefined,
		peer: LanHostRealtimePeer | undefined,
		dictation: CodexDictationTranscriber | undefined;
	const alive = new Set<WebSocket>();
	// Bound idle peers; heartbeat releases microphone ownership after a lost network connection.
	const heartbeat = setInterval(() => {
		for (const socket of sockets.clients) {
			if (!alive.delete(socket)) socket.terminate();
			else socket.ping();
		}
	}, 15_000);
	heartbeat.unref();
	let busy = false,
		closed = false;
	const send = (socket: WebSocket, value: JsonValue) => {
		if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 512 * 1024) socket.send(JSON.stringify(value));
	};
	const broadcast = (value: JsonValue) => {
		for (const socket of sockets.clients) send(socket, value);
	};
	const state = () => {
		for (const socket of sockets.clients)
			send(socket, {
				type: "state",
				status: voice.status,
				active: voice.active,
				dictating: dictation !== undefined,
				muted: voice.muted,
				owner: socket === owner,
			});
	};
	const dispose = voice.subscribe(state);
	const identities = new Set([...certificate.hostnames, ...certificate.ipAddresses]);
	server.on("upgrade", (request, socket, head) => {
		const supplied = request.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim())[1] ?? "";
		let origin: URL | undefined;
		try {
			origin = new URL(request.headers.origin ?? "");
		} catch {
			/* rejected below */
		}
		if (
			closed ||
			sockets.clients.size >= 8 ||
			request.url !== "/socket" ||
			!origin ||
			origin.protocol !== "https:" ||
			!identities.has(origin.hostname) ||
			origin.host !== request.headers.host ||
			!validPhoneToken(supplied, token)
		) {
			socket.destroy();
			return;
		}
		sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, request));
	});
	sockets.on("connection", (socket) => {
		alive.add(socket);
		socket.on("pong", () => alive.add(socket));
		state();
		socket.on("error", () => {});
		socket.on("close", () => {
			alive.delete(socket);
			if (owner !== socket) return;
			owner = undefined;
			if (voice.active && !voice.muted) voice.mute();
			void dictation?.close();
			dictation = undefined;
			state();
		});
		socket.on("message", (raw, binary) => {
			if (closed) return;
			if (binary) {
				if (owner !== socket) return;
				const pcm = bytes(raw);
				if (!pcm.length || pcm.length > 48 * 1024 || pcm.length % 2) {
					socket.close(1009);
					return;
				}
				if (dictation) dictation.append(pcm);
				else if (!voice.muted) peer?.sendAudio(pcm);
				return;
			}
			const operation = async () => {
				if (Buffer.byteLength(bytes(raw)) > 64 * 1024) throw new Error("Phone control message is too large");
				// type-boundary: browser JSON controls; validate command and its fields before acting.
				type ControlBoundary = unknown;
				const message: ControlBoundary = JSON.parse(bytes(raw).toString());
				if (!message || typeof message !== "object" || !("type" in message)) throw new Error("Invalid phone control");
				if (message.type === "text" && "text" in message && typeof message.text === "string" && message.text.trim()) {
					voice.input(message.text, ctx.isIdle() ? undefined : "steer");
					pi.sendUserMessage(message.text, { deliverAs: "steer" });
					return;
				}
				if (message.type === "stop") {
					owner = undefined;
					await dictation?.close();
					dictation = undefined;
					await voice.stop();
					peer = undefined;
					state();
					return;
				}
				if (busy) throw new Error("Voice is starting or changing mode; wait for it to finish");
				busy = true;
				try {
					if (message.type === "start") {
						if (dictation) throw new Error("Finish dictation before starting voice");
						if (voice.active && !peer) throw new Error("Stop desktop voice before taking phone input");
						owner = socket;
						state();
						if (!voice.active)
							await voice.start(ctx, () => {
								peer = new LanHostRealtimePeer({
									onAudio: (pcm) => {
										if (owner?.readyState === WebSocket.OPEN && owner.bufferedAmount < 512 * 1024) owner.send(pcm);
									},
								});
								return peer;
							});
						if (closed) {
							await voice.stop(false);
							return;
						}
						if (owner === socket && socket.readyState === WebSocket.OPEN) {
							if (voice.muted) voice.mute();
						} else if (voice.active && !voice.muted) voice.mute();
					} else if (message.type === "mute" && owner === socket) voice.mute();
					else if (message.type === "dictate") {
						if (voice.active || dictation) throw new Error("Stop voice before starting dictation");
						owner = socket;
						const current = new CodexDictationTranscriber({
							onError: (error) => {
								send(socket, { type: "error", message: error.message });
								if (dictation === current) {
									dictation = undefined;
									owner = undefined;
									void current.close();
									state();
								}
							},
							onStatus: (status) => send(socket, { type: "dictation", status }),
						});
						dictation = current;
						state();
						send(socket, { type: "dictation", status: "connecting" });
						const auth = await resolveCodexVoiceAuth(ctx);
						if (closed || owner !== socket || dictation !== current) {
							await current.close();
							return;
						}
						await current.start(auth);
						if (closed || owner !== socket) {
							await current.close();
							if (dictation === current) dictation = undefined;
						}
					} else if (message.type === "finish_dictation" && owner === socket && dictation) {
						const transcript = await dictation.finish();
						dictation = undefined;
						owner = undefined;
						if (transcript) send(socket, { type: "draft", text: transcript });
					} else throw new Error("Unknown phone control");
				} catch (error) {
					if (
						owner === socket &&
						(message.type === "start" || message.type === "dictate" || message.type === "finish_dictation")
					) {
						owner = undefined;
						await dictation?.close();
						dictation = undefined;
						if (voice.active && !voice.muted) voice.mute();
					}
					throw error;
				} finally {
					busy = false;
					state();
				}
			};
			void operation().catch((error) =>
				send(socket, { type: "error", message: error instanceof Error ? error.message : String(error) }),
			);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "0.0.0.0", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Phone server has no address");
	return {
		urls: certificate.ipAddresses
			.filter((ip) => ip !== "127.0.0.1")
			.concat("127.0.0.1")
			.map((ip) => `https://${ip}:${address.port}/#${token}`),
		message: (text) => broadcast({ type: "message", text }),
		async close() {
			closed = true;
			clearInterval(heartbeat);
			dispose();
			await dictation?.close();
			if (peer || busy) await voice.stop(false);
			for (const socket of sockets.clients) socket.terminate();
			sockets.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
