import { expect, test } from "bun:test";
import { CodexRealtimeConversation, type CodexConversationCallbacks } from "../src/conversation/session.ts";
import type { CodexRealtimePeer, CodexRealtimePeerEvent } from "../src/conversation/peer.ts";
import type { JsonValue } from "../src/wire-value.ts";
import { getVoiceConfig } from "../src/settings.ts";

class Peer implements CodexRealtimePeer {
	readonly kind = "webrtc";
	listener?: (event: CodexRealtimePeerEvent) => void;
	closed = false;
	muted = false;
	sent: JsonValue[] = [];
	onEvent(listener: (event: CodexRealtimePeerEvent) => void) {
		this.listener = listener;
		return () => {
			this.listener = undefined;
		};
	}
	onExit() {
		return () => {};
	}
	async start() {
		return "offer";
	}
	applyAnswer() {
		this.listener?.({ type: "state", state: "ready" });
	}
	sendData(message: JsonValue) {
		this.sent.push(message);
	}
	setInputMuted(value: boolean) {
		this.muted = value;
	}
	async close() {
		this.closed = true;
	}
}
const auth = { headers: new Headers(), baseUrl: "https://test.invalid", officialCodex: true };
function callbacks(): CodexConversationCallbacks {
	return {
		onError: () => {},
		onDrop: () => {},
		onStatus: () => {},
		onTurn: () => {},
		onUserTranscript: () => {},
		onTranscriptTail: () => {},
	};
}

test("voice startup sends readable context and preserves mute before the peer becomes ready", async () => {
	const peer = new Peer();
	let request = "";
	const call = new CodexRealtimeConversation(callbacks(), peer, async (_endpoint, _headers, _signal, body) => {
		request = body;
		return { status: 201, answer: "answer" };
	});
	try {
		await call.start(
			auth,
			getVoiceConfig(),
			"Voice instructions",
			[{ type: "message", role: "developer", content: [{ type: "input_text", text: "Current task" }] }],
			true,
		);
		call.markEstablished();
		expect(JSON.parse(request).session.initial_items[0].content[0].text).toBe("Current task");
		expect(peer.muted).toBe(true);
		expect(call.microphoneMuted).toBe(true);
		call.setInputMuted(false);
		expect(peer.muted).toBe(false);
	} finally {
		await call.close();
	}
	expect(peer.closed).toBe(true);
});

test("closing a call cancels an in-flight setup request without opening another peer", async () => {
	const peer = new Peer();
	const entered = Promise.withResolvers<void>();
	const call = new CodexRealtimeConversation(callbacks(), peer, async (_endpoint, _headers, signal) => {
		entered.resolve();
		return new Promise((_, reject) =>
			signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
		);
	});
	const started = call.start(auth, getVoiceConfig(), "Instructions").catch((error: Error) => error);
	await entered.promise;
	await call.close();
	expect(await started).toMatchObject({ message: "aborted" });
	expect(peer.closed).toBe(true);
});
