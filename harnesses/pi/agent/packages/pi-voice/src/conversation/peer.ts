import type { JsonValue } from "../wire-value.ts";
import type { VoiceConfig } from "../settings.ts";

export const MAX_REALTIME_SDP_BYTES = 256 * 1024;

export type CodexRealtimePeerEvent =
	| { type: "state"; state: string }
	| { type: "data"; message: JsonValue }
	| { type: "error"; message: string };

interface CodexRealtimePeerBase {
	onEvent(listener: (event: CodexRealtimePeerEvent) => void): () => void;
	onExit(listener: (error: Error) => void): () => void;
	sendData(message: JsonValue): void;
	setInputMuted(muted: boolean): void;
	close(): Promise<void>;
}

export interface CodexRealtimeWebRtcPeer extends CodexRealtimePeerBase {
	readonly kind: "webrtc";
	start(config: VoiceConfig): Promise<string>;
	applyAnswer(sdp: string): void;
}

export type CodexRealtimePeer = CodexRealtimeWebRtcPeer;
